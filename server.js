// --- Email Server (Node.js + SendGrid) ---
// This file is your backend.
// Deploy this to Render.com
// -------------------------------------------

// The "dotenv" import was removed from here. It's not needed for Render.
import express from 'express';
import cors from 'cors';
import sgMail from '@sendgrid/mail';

const app = express();
const port = process.env.PORT || 3000;

// --- Middleware ---
// 1. Enable CORS for all requests (allows your GitHub Pages site to talk to this server)
app.use(cors());
// 2. Enable JSON body parsing (to read data from your app)
app.use(express.json());

// --- Check for API Keys ---
// This is the most important step. Your server will crash if these are not set.
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL; // The "Single Sender" email you verified

if (!SENDGRID_API_KEY || !SENDER_EMAIL) {
    console.error("FATAL ERROR: SENDGRID_API_KEY or SENDER_EMAIL environment variables are not set.");
    // We'll let it run so it can at least respond with an error.
} else {
    sgMail.setApiKey(SENDGRID_API_KEY);
    console.log("SendGrid API key loaded.");
}

// --- Routes ---

// 1. Health Check Route
app.get('/', (req, res) => {
    res.status(200).json({ status: "ok", message: "Email server is running." });
});

// 2. Send Email Route
app.post('/send-email', async (req, res) => {
    console.log("Received /send-email request...");
    
    if (!SENDGRID_API_KEY || !SENDER_EMAIL) {
        console.error("Email failed: Server is missing API key or Sender email.");
        return res.status(500).json({ error: "Email server is not configured correctly." });
    }

    // Get data from the app's request
    const { to, subject, text, bcc } = req.body;

    // Validate input (subject and text are always required)
    if (!subject || !text) {
         console.warn("Request blocked: Missing subject or text.");
        return res.status(400).json({ error: "Missing required fields: subject, text" });
    }
    
    // --- NEW FIX: Construct the message object dynamically ---
    const msg = {
        from: SENDER_EMAIL,
        subject: subject,
        text: text,
    };

    if (bcc && bcc.length > 0) {
        // --- THIS IS THE FIX ---
        // This is an "Email Class" request.
        // SendGrid requires a 'to' field. We'll use our own sender
        // email as the 'to' recipient, and put all parents in 'bcc'.
        msg.to = SENDER_EMAIL;
        msg.bcc = bcc;
    } else if (to) {
        // This is a normal, single-recipient email.
        msg.to = to;
    } else {
        // No 'to' or 'bcc' was provided.
        console.warn("Request blocked: No 'to' or 'bcc' address provided.");
        return res.status(400).json({ error: "No recipient address provided." });
    }
    
    // --- Send the email ---
    try {
        await sgMail.send(msg);
        console.log(`Email successfully sent to: ${msg.to} (BCC: ${bcc ? bcc.length : 0})`);
        res.status(200).json({ success: true, message: "Email sent successfully" });
    } catch (error) {
        console.error("--- SENDGRID ERROR ---");
        console.error(error);
        if (error.response) {
            console.error("SendGrid Response Body:", error.response.body.errors);
        }
        console.error("------------------------");
        // Send a more specific error message back to the client
        let friendlyError = error.message;
        if (error.response && error.response.body && error.response.body.errors) {
            friendlyError = error.response.body.errors.map(e => e.message).join('; ');
        }
        res.status(500).json({ error: `Failed to send email: ${friendlyError}` });
    }
});

// --- Start the server ---
app.listen(port, () => {
    console.log(`Email server listening on port ${port}`);
});


