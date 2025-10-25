const express = require('express');
const sgMail = require('@sendgrid/mail'); // Import SendGrid
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- NEW ENVIRONMENT VARIABLE ---
// We now need the SendGrid API Key.
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
// We also need to know which email you verified with SendGrid.
const SENDGRID_VERIFIED_SENDER = process.env.SENDGRID_VERIFIED_SENDER;

if (!SENDGRID_API_KEY || !SENDGRID_VERIFIED_SENDER) {
    console.error('FATAL ERROR: SENDGRID_API_KEY or SENDGRID_VERIFIED_SENDER environment variables are not set.');
    process.exit(1); // Stop the server
}

// Set the API key for SendGrid
sgMail.setApiKey(SENDGRID_API_KEY);
console.log('SendGrid mailer is configured.');

// POST endpoint to send emails
app.post('/send-email', async (req, res) => {
    console.log('Received /send-email request for:', req.body.to);
    const { to, subject, text } = req.body;

    if (!to || !subject || !text) {
        console.error('Request missing required fields.');
        return res.status(400).json({ error: 'Missing required fields: to, subject, text' });
    }

    // --- NEW SENDGRID PAYLOAD ---
    const msg = {
        to: to, // The recipient
        from: SENDGRID_VERIFIED_SENDER, // Your *verified* sender email
        subject: subject,
        text: text,
    };
    // ----------------------------

    try {
        await sgMail.send(msg);
        console.log('Email sent successfully to:', to);
        res.status(200).json({ message: 'Email sent successfully' });
    } catch (error) {
        console.error('Error sending email:', error);
        if (error.response) {
            console.error(error.response.body); // Log detailed error from SendGrid
        }
        res.status(500).json({ error: 'Failed to send email' });
    }
});

// Root endpoint for health check
app.get('/', (req, res) => {
    res.status(200).send('SendGrid Email server is running.');
});

// Start the server
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});

