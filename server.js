// --- Email Server (Node.js + SendGrid) ---
// This file is your backend.
// Deploy this to Render.com
// -------------------------------------------

import 'dotenv/config'; // Load environment variables from .env file (for local testing)
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
    // In a real app, you might not want to exit, but for this simple server, it's fine.
    // We'll let it run so it can at least respond with an error.
} else {
    sgMail.setApiKey(SENDGRID_API_KEY);
    console.log("SendGrid API key loaded.");
}

// --- Routes ---

// 1. Health Check Route
// A simple route to check if the server is awake.
app.get('/', (req, res) => {
    res.status(200).json({ status: "ok", message: "Email server is running." });
});

// 2. Send Email Route
// This is the main endpoint your app will call.
app.post('/send-email', async (req, res) => {
    console.log("Received /send-email request...");
    
    // Check for keys again in case the server was started without them
    if (!SENDGRID_API_KEY || !SENDER_EMAIL) {
        console.error("Email failed: Server is missing API key or Sender email.");
        return res.status(500).json({ error: "Email server is not configured correctly." });
    }

    // Get data from the app's request
    const { to, subject, text, bcc } = req.body;

    // Validate input (a 'to' or 'bcc' is required)
    if ((!to || to.trim() === '') && (!bcc || bcc.length === 0)) {
        console.warn("Request blocked: No 'to' or 'bcc' address provided.");
        return res.status(400).json({ error: "No recipient address provided." });
    }
    
    // Construct the email message
    const msg = {
        from: SENDER_EMAIL, // This MUST be your verified "Single Sender" email
        to: to,             // The single recipient (e.g., "parent@example.com")
        bcc: bcc,           // The list of recipients for "Email Class"
        subject: subject,
        text: text,
        // html: "<strong>and easy to do anywhere, even with Node.js</strong>", // You can add HTML later
    };

    // --- Send the email ---
    try {
        await sgMail.send(msg);
        console.log(`Email successfully sent to: ${to || 'BCC list'}`);
        res.status(200).json({ success: true, message: "Email sent successfully" });
    } catch (error) {
        console.error("--- SENDGRID ERROR ---");
        console.error(error);
        if (error.response) {
            console.error("SendGrid Response Body:", error.response.body);
        }
        console.error("------------------------");
        res.status(500).json({ error: `Failed to send email: ${error.message}` });
    }
});

// --- Start the server ---
app.listen(port, () => {
    console.log(`Email server listening on port ${port}`);
});

