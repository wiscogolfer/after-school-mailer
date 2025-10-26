import express from 'express';
import cors from 'cors'; // Import cors
import admin from 'firebase-admin';
import sgMail from '@sendgrid/mail';

const app = express();
app.use(cors()); // Enable CORS for all origins
app.use(express.json());

// --- Firebase Admin SDK Setup ---
let adminApp; // Variable to hold the initialized app
try {
    // Attempt to parse the service account key from environment variable
    const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!serviceAccountString) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set.");
    }
    const serviceAccount = JSON.parse(serviceAccountString);

    adminApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_KEY env var is missing, invalid JSON, or SDK init failed.", error.message);
    // Log the beginning of the key if it exists, to help debug JSON parsing
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        console.error("Key starts with:", process.env.FIREBASE_SERVICE_ACCOUNT_KEY.substring(0, 30) + "...");
    }
     // Don't exit, allow server to run but endpoints needing admin will fail
}
// ---------------------------------

// --- SendGrid Setup ---
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL;

if (SENDGRID_API_KEY && SENDER_EMAIL) {
    sgMail.setApiKey(SENDGRID_API_KEY);
    console.log("SendGrid configured.");
} else {
    console.warn("WARN: SENDGRID_API_KEY or SENDER_EMAIL environment variables are not set. Email sending will fail.");
}
// -----------------------

// --- Middleware for Authentication ---
const authenticateToken = async (req, res, next) => {
    // Check if Admin SDK initialized
    if (!adminApp) {
        console.error("Auth Middleware Error: Firebase Admin SDK not initialized.");
        return res.status(500).json({ error: 'Server configuration error.' });
    }
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

    if (token == null) {
        return res.status(401).json({ error: 'Authentication token required.' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken; // Add user info to the request object
        next(); // Proceed to the next middleware or route handler
    } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(403).json({ error: 'Invalid or expired token.' });
    }
};
// ------------------------------------

// --- API Endpoints ---

// Simple ping endpoint
app.get('/', (req, res) => {
    res.status(200).send('Server is running.');
});

// Send Email Endpoint
app.post('/send-email', async (req, res) => {
    console.log("Received /send-email request"); // Log request arrival

    if (!SENDGRID_API_KEY || !SENDER_EMAIL) {
        console.error("Send Email Error: Email server is not configured correctly (missing API key or sender email).");
        return res.status(500).json({ error: 'Email server is not configured correctly.' });
    }

    const { to, bcc, subject, text } = req.body;

    // Validate required fields
    if (!subject || !text || (!to && !(bcc && bcc.length > 0))) {
        console.warn("Send Email Validation Error: Missing required fields (subject, text, and to/bcc).");
        return res.status(400).json({ error: 'Missing required fields: subject, text, and either to or bcc.' });
    }
    
    // If sending BCC, use sender as the 'to' field for SendGrid API compliance
    const recipientEmail = (bcc && bcc.length > 0) ? SENDER_EMAIL : to;

    const msg = {
        to: recipientEmail, // Use sender if BCC, otherwise use the 'to' field
        from: SENDER_EMAIL, // Must be your verified sender email
        subject: subject,
        text: text,
        bcc: (bcc && bcc.length > 0) ? bcc : undefined // Add BCC only if provided
    };

    try {
        console.log(`Attempting to send email via SendGrid. To: ${recipientEmail}, BCC count: ${bcc ? bcc.length : 0}`);
        await sgMail.send(msg);
        console.log('Email sent successfully via SendGrid');
        res.status(200).json({ message: 'Email sent successfully!' });
    } catch (error) {
        // Log detailed SendGrid error if available
        console.error('Error sending email via SendGrid:', error.response ? JSON.stringify(error.response.body) : error.message);
        res.status(500).json({ error: `Failed to send email: ${error.message}` });
    }
});


// --- User Management Endpoints (Auth Required) ---

// List all Firebase Auth users
app.get('/list-users', authenticateToken, async (req, res) => {
    console.log(`User ${req.user.email} requesting user list.`);
     // Check if Admin SDK initialized (needed here as it's the first use)
    if (!adminApp) {
        console.error("List Users Error: Firebase Admin SDK not initialized.");
        return res.status(500).json({ error: 'Server configuration error (Admin SDK).' });
    }
    try {
        const listUsersResult = await admin.auth().listUsers(1000); // Max 1000 users per page
        // Map user records to a simpler format
        const users = listUsersResult.users.map(userRecord => ({
            uid: userRecord.uid,
            email: userRecord.email,
        }));
        console.log(`Successfully listed ${users.length} users.`);
        res.status(200).json({ users });
    } catch (error) {
        console.error('Error listing users:', error);
        res.status(500).json({ error: `Failed to list users: ${error.message}` });
    }
});

// Create a new Firebase Auth user
app.post('/create-user', authenticateToken, async (req, res) => {
    // *** NEW LOGGING ***
    console.log(`Received /create-user request from ${req.user.email}. Payload:`, req.body);
    const { email, password } = req.body;

    // Check if Admin SDK initialized
    if (!adminApp) {
        console.error("Create User Error: Firebase Admin SDK not initialized.");
        return res.status(500).json({ error: 'Server configuration error (Admin SDK).' });
    }

    // Basic validation
    if (!email || !password) {
        console.warn("Create User Validation Error: Missing email or password.");
        return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (password.length < 6) {
        console.warn("Create User Validation Error: Password too short.");
        return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    try {
        // *** NEW LOGGING ***
        console.log(`Attempting to create user: ${email}`);
        // Create user using Firebase Admin SDK
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
        });
        console.log(`Successfully created new user: ${userRecord.uid} (${userRecord.email})`);
        res.status(201).json({ uid: userRecord.uid, email: userRecord.email });
    } catch (error) {
        // *** NEW LOGGING ***
        console.error(`Error creating new user ${email}:`, error);
        // Handle specific Firebase Auth errors
        if (error.code === 'auth/email-already-exists') {
             res.status(409).json({ error: 'Email address is already in use.' });
        } else if (error.code === 'auth/invalid-password') {
             res.status(400).json({ error: 'Invalid password format (must be >= 6 chars).' }); // More specific
        } else {
             // Generic error for other issues
             res.status(500).json({ error: `Failed to create user: ${error.message}` }); // Include original message
        }
    }
});

// Delete a Firebase Auth user
app.post('/delete-user', authenticateToken, async (req, res) => {
    console.log(`User ${req.user.email} attempting to delete user.`);
    const { uid } = req.body; // UID of the user to delete

    // Check if Admin SDK initialized
    if (!adminApp) {
        console.error("Delete User Error: Firebase Admin SDK not initialized.");
        return res.status(500).json({ error: 'Server configuration error (Admin SDK).' });
    }

    // Validate input
    if (!uid) {
        console.warn("Delete User Validation Error: Missing UID.");
        return res.status(400).json({ error: 'User ID (uid) is required.' });
    }
    
    // Prevent self-deletion
    if (uid === req.user.uid) {
        console.warn(`Delete User Auth Error: User ${req.user.email} attempted self-deletion.`);
        return res.status(400).json({ error: 'Cannot delete your own account.' });
    }

    try {
        console.log(`Attempting to delete user: ${uid}`);
        // Delete user using Firebase Admin SDK
        await admin.auth().deleteUser(uid);
        console.log(`Successfully deleted user: ${uid}`);
        res.status(200).json({ message: 'User deleted successfully.' });
    } catch (error) {
        console.error(`Error deleting user ${uid}:`, error);
        // Handle specific Firebase Auth errors
        if (error.code === 'auth/user-not-found') {
            res.status(404).json({ error: 'User not found.' });
        } else {
            // Generic error for other issues
            res.status(500).json({ error: `Failed to delete user: ${error.message}` });
        }
    }
});

// ---------------------------------------------

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

