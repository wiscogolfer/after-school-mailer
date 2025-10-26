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
        if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
            console.error("Key starts with:", process.env.FIREBASE_SERVICE_ACCOUNT_KEY.substring(0, 30) + "...");
        }
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
            // Verify the token and decode it
            const decodedToken = await admin.auth().verifyIdToken(token);
            // Add decoded token (which includes claims like `admin`) to the request object
            req.user = decodedToken;
            next();
        } catch (error) {
            console.error("Token verification failed:", error);
            return res.status(403).json({ error: 'Invalid or expired token.' });
        }
    };

    // --- NEW: Middleware for Admin Check ---
    const isAdmin = (req, res, next) => {
        // Check if the decoded token from authenticateToken has the admin claim
        if (req.user && req.user.admin === true) {
            next(); // User is admin, proceed
        } else {
            console.warn(`Admin access denied for user: ${req.user ? req.user.email : 'Unknown'}`);
            res.status(403).json({ error: 'Admin privileges required.' });
        }
    };
    // ------------------------------------

    // --- API Endpoints ---

    // Simple ping endpoint
    app.get('/', (req, res) => {
        res.status(200).send('Server is running.');
    });

    // Send Email Endpoint (No auth required)
    app.post('/send-email', async (req, res) => {
        console.log("Received /send-email request");

        if (!SENDGRID_API_KEY || !SENDER_EMAIL) {
            console.error("Send Email Error: Email server is not configured correctly.");
            return res.status(500).json({ error: 'Email server is not configured correctly.' });
        }
        // ... (rest of send-email logic remains the same)
        const { to, bcc, subject, text } = req.body;
        if (!subject || !text || (!to && !(bcc && bcc.length > 0))) {
            console.warn("Send Email Validation Error: Missing required fields.");
            return res.status(400).json({ error: 'Missing required fields: subject, text, and either to or bcc.' });
        }
        // FIX: Use SENDER_EMAIL as the 'to' address when sending only BCC
        const recipientEmail = (bcc && bcc.length > 0 && !to) ? SENDER_EMAIL : to;
         if (!recipientEmail) {
             console.warn("Send Email Validation Error: No valid recipient (to or bcc).");
            return res.status(400).json({ error: 'Missing required recipient address.' });
         }

        const msg = {
            to: recipientEmail,
            from: SENDER_EMAIL,
            subject: subject,
            text: text,
            bcc: (bcc && bcc.length > 0) ? bcc : undefined
        };
        try {
            console.log(`Attempting to send email via SendGrid. To: ${recipientEmail}, BCC count: ${bcc ? bcc.length : 0}`);
            await sgMail.send(msg);
            console.log('Email sent successfully via SendGrid');
            res.status(200).json({ message: 'Email sent successfully!' });
        } catch (error) {
            console.error('Error sending email via SendGrid:', error.response ? JSON.stringify(error.response.body) : error.message);
            res.status(500).json({ error: `Failed to send email: ${error.message}` });
        }
    });


    // --- User Management Endpoints ---

    // List all Firebase Auth users (Requires login)
    // MODIFIED: Returns admin status for each user
    app.get('/list-users', authenticateToken, async (req, res) => {
        console.log(`User ${req.user.email} requesting user list.`);
        if (!adminApp) {
            console.error("List Users Error: Firebase Admin SDK not initialized.");
            return res.status(500).json({ error: 'Server configuration error (Admin SDK).' });
        }
        try {
            const listUsersResult = await admin.auth().listUsers(1000);
            // Map user records AND include their admin claim status
            const users = listUsersResult.users.map(userRecord => ({
                uid: userRecord.uid,
                email: userRecord.email,
                isAdmin: userRecord.customClaims?.admin === true // Check for admin claim
            }));
            console.log(`Successfully listed ${users.length} users.`);
            res.status(200).json({ users });
        } catch (error) {
            console.error('Error listing users:', error);
            res.status(500).json({ error: `Failed to list users: ${error.message}` });
        }
    });

    // Create a new Firebase Auth user (Requires ADMIN login)
    // MODIFIED: Added isAdmin middleware
    app.post('/create-user', authenticateToken, isAdmin, async (req, res) => { // Added isAdmin middleware
        console.log(`ADMIN ${req.user.email} creating user. Payload:`, req.body);
        const { email, password } = req.body;

        if (!adminApp) {
            console.error("Create User Error: Firebase Admin SDK not initialized.");
            return res.status(500).json({ error: 'Server configuration error (Admin SDK).' });
        }
        if (!email || !password) {
            console.warn("Create User Validation Error: Missing email or password.");
            return res.status(400).json({ error: 'Email and password are required.' });
        }
        if (password.length < 6) {
            console.warn("Create User Validation Error: Password too short.");
            return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
        }

        try {
            console.log(`Attempting to create user: ${email}`);
            const userRecord = await admin.auth().createUser({
                email: email,
                password: password,
                // New users are NOT admins by default
            });
            console.log(`Successfully created new user: ${userRecord.uid} (${userRecord.email})`);
            res.status(201).json({ uid: userRecord.uid, email: userRecord.email, isAdmin: false }); // Return isAdmin status
        } catch (error) {
            console.error(`Error creating new user ${email}:`, error);
            if (error.code === 'auth/email-already-exists') {
                 res.status(409).json({ error: 'Email address is already in use.' });
            } else if (error.code === 'auth/invalid-password') {
                 res.status(400).json({ error: 'Invalid password format (must be >= 6 chars).' });
            } else {
                 res.status(500).json({ error: `Failed to create user: ${error.message}` });
            }
        }
    });

    // Delete a Firebase Auth user (Requires ADMIN login)
    // MODIFIED: Added isAdmin middleware
    app.post('/delete-user', authenticateToken, isAdmin, async (req, res) => { // Added isAdmin middleware
        console.log(`ADMIN ${req.user.email} attempting to delete user.`);
        const { uid } = req.body;

        if (!adminApp) {
            console.error("Delete User Error: Firebase Admin SDK not initialized.");
            return res.status(500).json({ error: 'Server configuration error (Admin SDK).' });
        }
        if (!uid) {
            console.warn("Delete User Validation Error: Missing UID.");
            return res.status(400).json({ error: 'User ID (uid) is required.' });
        }
        if (uid === req.user.uid) {
            console.warn(`Delete User Auth Error: Admin ${req.user.email} attempted self-deletion.`);
            return res.status(400).json({ error: 'Cannot delete your own account.' });
        }

        try {
            console.log(`Attempting to delete user: ${uid}`);
            await admin.auth().deleteUser(uid);
            console.log(`Successfully deleted user: ${uid}`);
            res.status(200).json({ message: 'User deleted successfully.' });
        } catch (error) {
            console.error(`Error deleting user ${uid}:`, error);
            if (error.code === 'auth/user-not-found') {
                res.status(404).json({ error: 'User not found.' });
            } else {
                res.status(500).json({ error: `Failed to delete user: ${error.message}` });
            }
        }
    });

    // --- NEW: Set Admin Endpoint ---
    // Allows an existing admin OR the first user ever to set admin claims
    app.post('/set-admin', authenticateToken, async (req, res) => {
        const { uidToMakeAdmin } = req.body; // The UID of the user to grant admin rights
        const callerUid = req.user.uid; // The UID of the user making the request

        console.log(`User ${req.user.email} attempting to set admin status for UID: ${uidToMakeAdmin}`);

        if (!adminApp) {
            console.error("Set Admin Error: Firebase Admin SDK not initialized.");
            return res.status(500).json({ error: 'Server configuration error (Admin SDK).' });
        }
        if (!uidToMakeAdmin) {
            console.warn("Set Admin Validation Error: Missing target UID.");
            return res.status(400).json({ error: 'User ID (uidToMakeAdmin) is required.' });
        }

        try {
            let canSetAdmin = false;

            // Check 1: Is the caller already an admin?
            if (req.user.admin === true) {
                console.log(`Caller ${req.user.email} is an admin. Proceeding.`);
                canSetAdmin = true;
            } else {
                // Check 2: If caller is not admin, check if ANY admin exists yet (for bootstrapping)
                console.log(`Caller ${req.user.email} is not admin. Checking if any admins exist...`);
                const listUsersResult = await admin.auth().listUsers(1000); // Check first 1000 users
                const anyAdminExists = listUsersResult.users.some(user => user.customClaims?.admin === true);

                if (!anyAdminExists) {
                    console.log("No admins found. Allowing first user bootstrap.");
                    // Allow setting ONLY if the target is the caller themselves
                    if (uidToMakeAdmin === callerUid) {
                        console.log(`Caller ${req.user.email} is bootstrapping themselves as admin.`);
                        canSetAdmin = true;
                    } else {
                         console.warn(`Bootstrap denied: Caller ${req.user.email} tried to make someone else (${uidToMakeAdmin}) admin.`);
                         return res.status(403).json({ error: 'Only the first user can make themselves admin.' });
                    }
                } else {
                    console.log("An admin already exists. Denying non-admin request.");
                }
            }

            // Proceed if authorized
            if (canSetAdmin) {
                console.log(`Setting custom claim { admin: true } for user ${uidToMakeAdmin}`);
                await admin.auth().setCustomUserClaims(uidToMakeAdmin, { admin: true });
                console.log(`Successfully set admin claim for ${uidToMakeAdmin}`);

                // IMPORTANT: Force refresh of the target user's token on client-side is needed
                // The client-side code should handle this after a successful call.
                res.status(200).json({ message: `Admin privileges granted to user ${uidToMakeAdmin}. User must sign out and back in for changes to take effect.` });

            } else {
                // If we got here without canSetAdmin being true, it's an unauthorized attempt
                 console.warn(`Unauthorized attempt by ${req.user.email} to set admin for ${uidToMakeAdmin}.`);
                 return res.status(403).json({ error: 'Admin privileges required to perform this action.' });
            }

        } catch (error) {
            console.error(`Error setting admin claim for ${uidToMakeAdmin}:`, error);
             if (error.code === 'auth/user-not-found') {
                res.status(404).json({ error: 'Target user not found.' });
            } else {
                res.status(500).json({ error: `Failed to set admin claim: ${error.message}` });
            }
        }
    });
    // ---------------------------------------------


    // Start the server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
    

