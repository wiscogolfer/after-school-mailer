const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors'); // Import the cors package
const app = express();
const port = process.env.PORT || 3000;

// --- CRITICAL FIX ---
// Enable CORS for all routes. This allows your GitHub Pages
// site to make requests to your Render server.
app.use(cors());
// --------------------

// Middleware to parse JSON bodies
app.use(express.json());

// Check for required environment variables at startup
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GOOGLE_APP_PASSWORD;

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error('FATAL ERROR: GMAIL_USER or GOOGLE_APP_PASSWORD environment variables are not set.');
    process.exit(1); // Stop the server
}

// Create a Nodemailer transporter using your Google App Password
let transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // true for 465, false for other ports
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD,
    },
});

// Verify the transporter configuration on startup
transporter.verify((error, success) => {
    if (error) {
        console.error('Nodemailer config error:', error);
    } else {
        console.log('Nodemailer is ready to send emails');
    }
});

// POST endpoint to send emails
app.post('/send-email', async (req, res) => {
    const { to, subject, text } = req.body;

    if (!to || !subject || !text) {
        return res.status(400).json({ error: 'Missing required fields: to, subject, text' });
    }

    const mailOptions = {
        from: GMAIL_USER,
        to: to,
        subject: subject,
        text: text,
    };

    try {
        let info = await transporter.sendMail(mailOptions);
        console.log('Email sent: ' + info.response);
        res.status(200).json({ message: 'Email sent successfully' });
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).json({ error: 'Failed to send email', details: error.message });
    }
});

// Root endpoint for health check (Render uses this)
app.get('/', (req, res) => {
    res.status(200).send('Email server is running.');
});

// Start the server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});

