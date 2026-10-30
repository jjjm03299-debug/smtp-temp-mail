const { SMTPServer } = require("smtp-server");
const express = require("express");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const selfsigned = require("selfsigned");

const app = express();
const WEB_PORT = process.env.PORT || 3000;
const SMTP_PORT = 2525;

// In-memory storage for generated inboxes and received emails
const inboxes = new Map();

// Helper to generate a random unique username
function generateInbox() {
  const randomId = crypto.randomBytes(4).toString("hex"); // e.g., "a3f89b12"
  const username = `inbox-${randomId}`;
  inboxes.set(username, {
    username,
    createdAt: new Date(),
    emails: []
  });
  return username;
}

// Pre-create a default inbox on startup so you have one immediately
const defaultUser = generateInbox();

// --- GENERATE DYNAMIC SELF-SIGNED TLS CERTIFICATE ---
console.log("Generating self-signed TLS certificate for SMTP server...");
const attrs = [{ name: 'commonName', value: '*.replit.app' }];
const pems = selfsigned.generate(attrs, { days: 365 });
console.log("TLS Certificate generated successfully.");

// --- 1. SMTP SERVER SETUP (With TLS / STARTTLS Enabled) ---
const smtpServer = new SMTPServer({
  authOptional: true,
  // Pass the generated TLS keys to secure the server
  key: pems.private,
  cert: pems.cert,
  
  onData(stream, session, callback) {
    let emailData = "";

    stream.on("data", (chunk) => {
      emailData += chunk;
    });

    stream.on("end", () => {
      console.log("--- New Email Received via SMTP ---");
      const recipients = session.rcptTo.map(r => r.address);
      
      recipients.forEach(rcpt => {
        const localPart = rcpt.split("@")[0].toLowerCase();
        if (inboxes.has(localPart)) {
          const inbox = inboxes.get(localPart);
          inbox.emails.unshift({
            from: session.mailFrom?.address || "Unknown",
            to: rcpt,
            body: emailData,
            receivedAt: new Date().toISOString()
          });
          console.log(`Stored email for inbox: ${localPart}`);
        }
      });

      callback();
    });
  },

  onConnect(session, callback) {
    console.log(`SMTP Client connected: ${session.remoteAddress} (Secure: ${session.secure})`);
    callback();
  }
});

smtpServer.listen(SMTP_PORT, "0.0.0.0", () => {
  console.log(`Secure SMTP Server (TLS enabled) running on port ${SMTP_PORT}`);
});

// --- 2. WEB DASHBOARD & API SETUP (Express) ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Home page: lists active inboxes, lets you create new ones, or delete existing ones
app.get("/", (req, res) => {
  let html = `
    <h1>Replit Secure SMTP Inbox Checker</h1>
    <p>SMTP Server running on port <strong>${SMTP_PORT}</strong> with <strong>TLS/STARTTLS enabled</strong>.</p>
    <form action="/create" method="POST" style="margin-bottom: 20px;">
      <button type="submit" style="padding: 10px 15px; font-size: 16px; cursor: pointer; background: #28a745; color: #fff; border: none; border-radius: 4px;">Generate New Random Inbox</button>
    </form>
    <h2>Active Temporary Inboxes (${inboxes.size}):</h2>
    <ul style="list-style: none; padding: 0;">
  `;

  for (const [username, data] of inboxes.entries()) {
    html += `
      <li style="background: #f4f4f4; padding: 10px; margin-bottom: 8px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; max-width: 600px;">
        <div>
          <strong>${username}</strong> 
          <span style="color: #666; font-size: 14px;">(${data.emails.length} messages)</span>
        </div>
        <div>
          <a href="/inbox/${username}" style="margin-right: 10px; text-decoration: none; padding: 5px 10px; border-radius: 3px; background: #007bff; color: white;">Open</a>
          <form action="/inbox/${username}/delete" method="POST" style="display: inline;">
            <button type="submit" style="background: #dc3545; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer;">Delete</button>
          </form>
        </div>
      </li>
    `;
  }

  html += `</ul>`;
  res.send(html);
});

// Create a new inbox route
app.post("/create", (req, res) => {
  const newUsername = generateInbox();
  res.redirect(`/inbox/${newUsername}`);
});

// Delete an inbox route
app.post("/inbox/:username/delete", (req, res) => {
  const { username } = req.params;
  if (inboxes.has(username)) {
    inboxes.delete(username);
    console.log(`Deleted inbox: ${username}`);
  }
  res.redirect("/");
});

// JSON API: Get list of all created inboxes
app.get("/api/inboxes", (req, res) => {
  const list = Array.from(inboxes.values()).map(i => ({
    username: i.username,
    createdAt: i.createdAt,
    messageCount: i.emails.length
  }));
  res.json(list);
});

// JSON API: Delete a specific inbox
app.delete("/api/inbox/:username", (req, res) => {
  const { username } = req.params;
  if (!inboxes.has(username)) {
    return res.status(404).json({ error: "Inbox not found" });
  }
  inboxes.delete(username);
  res.json({ success: true, message: `Inbox ${username} deleted successfully.` });
});

// --- 3. POST /send Endpoint ---
app.post("/send", async (req, res) => {
  const { username, subject, text, from } = req.body;

  if (!username || !inboxes.has(username.toLowerCase())) {
    return res.status(400).json({ error: "Valid target 'username' is required and must exist." });
  }

  const targetInbox = username.toLowerCase();
  const senderEmail = from || "test-sender@example.com";
  const emailSubject = subject || "Hello from TLS API Test";
  const emailBody = text || "This is a secure test message sent via the POST /send endpoint.";

  try {
    const transporter = nodemailer.createTransport({
      host: "127.0.0.1",
      port: SMTP_PORT,
      secure: false, // use STARTTLS
      tls: { rejectUnauthorized: false } // Accept self-signed cert for local dispatch
    });

    await transporter.sendMail({
      from: senderEmail,
      to: `${targetInbox}@localhost`,
      subject: emailSubject,
      text: emailBody
    });

    if (req.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
      return res.redirect(`/inbox/${targetInbox}`);
    }

    res.json({ success: true, message: `Email successfully sent via TLS to ${targetInbox}` });
  } catch (err) {
    console.error("Error sending test email:", err);
    res.status(500).json({ error: "Failed to dispatch email", details: err.message });
  }
});

// View a specific inbox dashboard
app.get("/inbox/:username", (req, res) => {
  const { username } = req.params;
  if (!inboxes.has(username)) {
    return res.status(404).send("Inbox not found! <a href='/'>Go back</a>");
  }

  const inbox = inboxes.get(username);
  let html = `
    <div style="max-width: 700px; font-family: sans-serif; margin: 20px auto;">
      <h1>Inbox: ${username}</h1>
      <p>Send secure emails via SMTP to: <code>${username}@your-repl-subdomain.replit.app</code></p>
      <div style="margin-bottom: 15px;">
        <a href="/" style="text-decoration: none; background: #6c757d; color: white; padding: 6px 12px; border-radius: 4px; margin-right: 10px;">← Back to Home</a>
        <form action="/inbox/${username}/delete" method="POST" style="display: inline;">
          <button type="submit" style="background: #dc3545; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Delete This Inbox</button>
        </form>
      </div>
      <hr>
      
      <h3>Quick Test: Send Secure Message to this Inbox</h3>
      <form action="/send" method="POST" style="background: #eee; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
        <input type="hidden" name="username" value="${username}">
        <div style="margin-bottom: 10px;">
          <label>From: </label><br>
          <input type="email" name="from" value="sender@example.com" style="width: 100%; max-width: 400px; padding: 5px;">
        </div>
        <div style="margin-bottom: 10px;">
          <label>Subject: </label><br>
          <input type="text" name="subject" value="Secure TLS Test" style="width: 100%; max-width: 400px; padding: 5px;">
        </div>
        <div style="margin-bottom: 10px;">
          <label>Message Body: </label><br>
          <textarea name="text" rows="3" style="width: 100%; max-width: 400px; padding: 5px;">This is a test message sent over encrypted TLS/STARTTLS.</textarea>
        </div>
        <button type="submit" style="padding: 8px 15px; cursor: pointer; background: #007bff; color: white; border: none; border-radius: 4px;">Send Test Email Now</button>
      </form>
      
      <h2>Received Messages (${inbox.emails.length}):</h2>
  `;

  if (inbox.emails.length === 0) {
    html += `<p><em>No emails received yet. Use the form above or send mail via secure SMTP!</em></p>`;
  } else {
    inbox.emails.forEach((mail) => {
      html += `
        <div style="border: 1px solid #ccc; padding: 12px; margin-bottom: 12px; background: #f9f9f9; border-radius: 4px;">
          <p><strong>From:</strong> ${mail.from}</p>
          <p><strong>To:</strong> ${mail.to}</p>
          <p><strong>Received:</strong> ${mail.receivedAt}</p>
          <pre style="background: #fff; padding: 10px; border: 1px solid #ddd; white-space: pre-wrap; word-break: break-all;">${mail.body}</pre>
        </div>
      `;
    });
  }

  html += `</div>`;
  res.send(html);
});

// JSON API endpoint to check emails programmatically for a specific inbox
app.get("/api/inbox/:username", (req, res) => {
  const { username } = req.params;
  if (!inboxes.has(username)) {
    return res.status(404).json({ error: "Inbox not found" });
  }
  res.json(inboxes.get(username));
});

app.listen(WEB_PORT, "0.0.0.0", () => {
  console.log(`Web Dashboard running on port ${WEB_PORT}`);
  console.log(`Default generated inbox username: ${defaultUser}`);
});
