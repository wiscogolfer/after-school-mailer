// Import necessary modules
import express from 'express';
import cors from 'cors'; // Import CORS
import admin from 'firebase-admin';
import { Resend } from 'resend'; // <-- CHANGED: Import Resend
import { Buffer } from 'buffer'; // Import Buffer for base64 decoding

// --- Configuration ---
// Load environment variables securely (Render handles this)
const serviceAccountKeyBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
const resendApiKey = process.env.RESEND_API_KEY; // <-- CHANGED
const senderEmail = process.env.SENDER_EMAIL; // Verified sender in Resend

// Validate critical environment variables
if (!serviceAccountKeyBase64) {
    console.error('FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set.');
    process.exit(1);
}
if (!resendApiKey) { // <-- CHANGED
    console.error('FATAL ERROR: RESEND_API_KEY environment variable is not set.'); // <-- CHANGED
    process.exit(1);
}
if (!senderEmail) {
    console.error('FATAL ERROR: SENDER_EMAIL environment variable is not set.');
    process.exit(1);
}

// Decode the base64 service account key
let serviceAccount;
try {
    const serviceAccountJson = Buffer.from(serviceAccountKeyBase64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(serviceAccountJson);
} catch (error) {
    console.error('FATAL ERROR: Could not parse FIREBASE_SERVICE_ACCOUNT_KEY. Ensure it is a valid base64 encoded JSON string.', error);
    process.exit(1);
}


// --- Firebase Admin Initialization ---
try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("Firebase Admin SDK initialization failed:", error);
    process.exit(1);
}

// --- Resend Initialization ---
const resend = new Resend(resendApiKey); // <-- CHANGED
console.log("Resend configured."); // <-- CHANGED


// --- Express App Setup ---
const app = express();
const port = process.env.PORT || 3000; // Render provides the PORT env var

// --- Middleware ---
app.use(cors()); // Enable CORS for all origins
app.use(express.json()); // Parse JSON request bodies

// --- Authentication Middleware ---
// Verifies Firebase ID token sent from the client
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

    if (token == null) {
        console.log("Auth token missing");
        return res.status(401).json({ error: 'Authentication token required' }); // if there isn't any token
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken; // Add user info (including uid, email, claims) to request
        console.log(`Authenticated user: ${req.user.uid} (${req.user.email || 'No email'})`);
        next(); // Proceed to the next middleware or route handler
    } catch (error) {
        console.error('Token verification failed:', error);
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};

// --- Admin Check Middleware ---
// Checks if the authenticated user has the admin custom claim
const isAdmin = (req, res, next) => {
    if (req.user && req.user.admin === true) {
        console.log(`Admin check passed for user: ${req.user.uid}`);
        next(); // User is admin, proceed
    } else {
        console.log(`Admin check failed for user: ${req.user.uid}`);
        return res.status(403).json({ error: 'Admin privileges required' });
    }
};


// --- API Routes ---

// Test Route (Optional)
app.get('/', (req, res) => {
    res.send('After School Mailer Server is running!');
});

// --- Email Sending Route ---
// vvv THIS ENTIRE ROUTE IS UPDATED FOR RESEND vvv
app.post('/send-email', async (req, res) => {
    // Basic validation
    const { to, bcc, subject, text, replyTo } = req.body;
    console.log(`Received /send-email request. To: ${to}, BCC count: ${bcc ? bcc.length : 0}, ReplyTo: ${replyTo}, Subject: ${subject}`);

    // Resend requires 'to' even if using 'bcc' only. We'll use the sender's email as 'to' in that case.
    const recipient = to || (bcc && bcc.length > 0 ? senderEmail : null);

    if (!recipient || !subject || !text) {
        console.error("Validation failed: Missing fields.");
        return res.status(400).json({ error: 'Missing required fields: to/bcc, subject, text' });
    }

    try {
        console.log("Attempting to send email via Resend...");
        // This is the new Resend API call
        const { data, error } = await resend.emails.send({
            to: recipient,
            bcc: bcc || undefined,
            from: senderEmail, // Must be your verified Resend sender
            reply_to: replyTo || senderEmail, // Use provided replyTo or default to sender
            subject: subject,
            text: text,
            // html: '<strong>Optional HTML content</strong>',
        });

        // Resend returns an error object on failure
        if (error) {
            console.error('Resend Error:', error);
            return res.status(500).json({ error: 'Failed to send email. Check server logs.' });
        }

        console.log(`Email sent successfully. ID: ${data.id}, Subject: ${subject}`);
        res.status(200).json({ message: 'Email sent successfully!' });

    } catch (error) {
        // Catch any other network/unexpected errors
        console.error('Server Error:', error);
        res.status(500).json({ error: 'Failed to send email. Check server logs.' });
    }
});
// ^^^ THIS ENTIRE ROUTE IS UPDATED FOR RESEND ^^^


// --- User Management Routes (Protected by Auth and Admin) ---

// List Users
app.get('/list-users', authenticateToken, isAdmin, async (req, res) => {
    console.log(`User ${req.user.uid} requesting user list.`);
    try {
        const listUsersResult = await admin.auth().listUsers(1000); // Max 1000 per page
        const users = listUsersResult.users.map(userRecord => ({
            uid: userRecord.uid,
            email: userRecord.email,
            isAdmin: userRecord.customClaims?.admin === true // Check for admin claim
        }));
        console.log(`Successfully listed ${users.length} users.`);
        res.status(200).json({ users });
    } catch (error) {
        console.error('Error listing users:', error);
        res.status(500).json({ error: 'Failed to list users.' });
    }
});

// Create User
app.post('/create-user', authenticateToken, isAdmin, async (req, res) => {
    const { email, password } = req.body;
    console.log(`Admin ${req.user.uid} attempting to create user: ${email}`);
    if (!email || !password || password.length < 6) {
        console.error("Create user validation failed: Invalid email or password length.");
        return res.status(400).json({ error: 'Valid email and password (min 6 chars) required.' });
    }
    try {
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
        });
        console.log(`Successfully created user: ${userRecord.email} (UID: ${userRecord.uid})`);
        res.status(201).json({ uid: userRecord.uid, email: userRecord.email });
    } catch (error) {
        console.error('Error creating user:', error);
        // Provide specific error messages if known, otherwise generic
        let errorMessage = 'Failed to create user.';
        if (error.code === 'auth/email-already-exists') {
            errorMessage = 'Email address is already in use.';
        } else if (error.code === 'auth/invalid-password') {
             errorMessage = 'Password must be at least 6 characters long.';
        }
        res.status(500).json({ error: errorMessage });
    }
});

// Delete User
app.post('/delete-user', authenticateToken, isAdmin, async (req, res) => {
    const { uid } = req.body;
    console.log(`Admin ${req.user.uid} attempting to delete user: ${uid}`);
    if (!uid) {
        console.error("Delete user validation failed: UID missing.");
        return res.status(400).json({ error: 'User ID (uid) required.' });
    }
    if (uid === req.user.uid) {
        console.error("Delete user failed: Admin tried to delete self.");
        return res.status(400).json({ error: 'Admin cannot delete their own account.' });
    }
    try {
        await admin.auth().deleteUser(uid);
        console.log(`Successfully deleted user: ${uid}`);
        res.status(200).json({ message: 'User deleted successfully.' });
    } catch (error) {
        console.error(`Error deleting user ${uid}:`, error);
        let errorMessage = 'Failed to delete user.';
        if (error.code === 'auth/user-not-found') {
            errorMessage = 'User not found.';
        }
        res.status(500).json({ error: errorMessage });
    }
});

// Set Admin Claim
app.post('/set-admin', authenticateToken, async (req, res) => {
    const { uidToMakeAdmin } = req.body;
    const requestingUserUid = req.user.uid;
    console.log(`User ${requestingUserUid} attempting to set admin status for UID: ${uidToMakeAdmin}`);

    if (!uidToMakeAdmin) {
        console.error("Set admin validation failed: Target UID missing.");
        return res.status(400).json({ error: 'Target User ID (uidToMakeAdmin) required.' });
    }

    try {
        // --- Bootstrap Logic: Allow first user to make themselves admin ---
        let canSetAdmin = false;
        if (req.user.admin === true) {
            // Requesting user is already an admin, they can set others.
            canSetAdmin = true;
            console.log("Requesting user is an admin.");
        } else if (uidToMakeAdmin === requestingUserUid) {
            // Requesting user is trying to make themselves admin. Check if ANY admins exist.
            console.log("Requesting user trying to make self admin. Checking if any admins exist...");
            const listUsersResult = await admin.auth().listUsers(10); // Check a small number first
            const existingAdmins = listUsersResult.users.filter(u => u.customClaims?.admin === true);
            if (existingAdmins.length === 0) {
                // No admins found, allow this user to become the first admin.
                canSetAdmin = true;
                console.log("No existing admins found. Allowing bootstrap.");
            } else {
                 console.log("Existing admins found. Bootstrap disallowed.");
            }
        }

        if (!canSetAdmin) {
             console.log("Set admin permission denied.");
             return res.status(4S03).json({ error: 'Admin privileges required or bootstrap condition not met.' });
        }

        // Proceed with setting the claim
        await admin.auth().setCustomUserClaims(uidToMakeAdmin, { admin: true });
        console.log(`Successfully set admin claim for user: ${uidToMakeAdmin}`);
        res.status(200).json({ message: 'Admin privileges granted. User must sign out and back in for changes to take effect.' });

    } catch (error) {
        console.error(`Error setting admin claim for ${uidToMakeAdmin}:`, error);
        let errorMessage = 'Failed to set admin privileges.';
        if (error.code === 'auth/user-not-found') {
            errorMessage = 'Target user not found.';
        }
        res.status(5M00).json({ error: errorMessage });
    }
});


// --- Start Server ---
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});