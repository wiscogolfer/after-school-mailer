import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';

// Initialize Express app
const app = express();
const port = process.env.PORT || 3001; // Render will set the PORT environment variable

// Middleware
app.use(cors()); // Enable Cross-Origin Resource Sharing for your app
app.use(express.json()); // Parse incoming JSON bodies

// --- Nodemailer Transporter Setup (for Gmail) ---
// We will get these values from Render's Environment Variables
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("FATAL ERROR: GMAIL_USER or GMAIL_APP_PASSWORD environment variables are not set.");
    // We don't exit the process here, but sending email will fail.
    // Render will show this in the logs.
}

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD,
    },
});

// --- API Endpoints ---

// Health check endpoint for Render
app.get('/', (req, res) => {
    res.status(200).json({ status: 'Server is running' });
});

// Main endpoint for sending email
app.post('/send-email', async (req, res) => {
    const { to, subject, body } = req.body;

    // Check for missing environment variables
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
        console.error("Attempted to send email, but server is not configured. Missing GMAIL_USER or GMAIL_APP_PASSWORD.");
        return res.status(500).json({ success: false, message: "Server error: Email service not configured." });
    }

    // Basic validation
    if (!to || !subject || !body) {
        return res.status(400).json({ success: false, message: 'Missing required fields: to, subject, or body.' });
    }

    const mailOptions = {
        from: GMAIL_USER, // This is YOUR email (from environment variable)
        to: to,           // The recipient (from the app)
        subject: subject, // The subject (from the app)
        text: body,       // The plain-text body (from the app)
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Email sent successfully to ${to}`);
        res.status(200).json({ success: true, message: 'Email sent successfully!' });
    } catch (error) {
        console.error(`Failed to send email to ${to}:`, error);
        
        // Check for specific auth errors from Google
        if (error.code === 'EAUTH') {
            console.error("Authentication failed. Check GMAIL_USER and GMAIL_APP_PASSWORD.");
            return res.status(500).json({ success: false, message: "Server error: Authentication failed. Check your App Password." });
        }
        
        res.status(500).json({ success: false, message: 'Failed to send email. Check server logs.' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});

