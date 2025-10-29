// Import necessary modules
import express from 'express';
import cors from 'cors'; // Import CORS
import admin from 'firebase-admin';
import { Resend } from 'resend'; // Import Resend
import { Buffer } from 'buffer'; // Import Buffer for base64 decoding
import Stripe from 'stripe'; // Import Stripe

// --- Configuration ---
// Load environment variables securely (Render handles this)
const serviceAccountKeyBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const senderEmail = process.env.SENDER_EMAIL; // Verified sender in Resend
const stripeSecretKey = process.env.STRIPE_SECRET_KEY; // Stripe Secret Key
const organizationId = process.env.ORGANIZATION_ID || "State-48-Dance"; // Get Org ID or use default

// Validate critical environment variables
if (!serviceAccountKeyBase64) {
    console.error('FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set.');
    process.exit(1);
}
if (!resendApiKey) {
    console.error('FATAL ERROR: RESEND_API_KEY environment variable is not set.');
    process.exit(1);
}
if (!senderEmail) {
    console.error('FATAL ERROR: SENDER_EMAIL environment variable is not set.');
    process.exit(1);
}
if (!stripeSecretKey) {
    console.error('FATAL ERROR: STRIPE_SECRET_KEY environment variable is not set.');
    process.exit(1);
}
if (!organizationId) {
    // If organizationId is critical for Firestore paths, validate it.
    // If it's okay to use a default, you might remove this check.
    console.warn('WARNING: ORGANIZATION_ID environment variable not set. Using default:', organizationId);
    // process.exit(1); // Uncomment this if the org ID MUST be set via environment
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
const resend = new Resend(resendApiKey);
console.log("Resend configured.");

// --- Stripe Initialization ---
const stripe = Stripe(stripeSecretKey);
console.log("Stripe configured.");


// --- Express App Setup ---
const app = express();
const port = process.env.PORT || 3000; // Render provides the PORT env var

// --- Middleware ---
app.use(cors()); // Enable CORS for all origins
app.use(express.json()); // Parse JSON request bodies

// --- Authentication Middleware ---
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) {
        console.log("Auth token missing");
        return res.status(401).json({ error: 'Authentication token required' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        console.log(`Authenticated user: ${req.user.uid} (${req.user.email || 'No email'})`);
        next();
    } catch (error) {
        console.error('Token verification failed:', error);
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};

// --- Admin Check Middleware ---
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
app.post('/send-email', authenticateToken, async (req, res) => { // Added authenticateToken
    // 'replyTo' is an object: { email: '...', name: '...' }
    const { to, bcc, subject, text, replyTo } = req.body;

    console.log("--------------------");
    console.log("DEBUG /send-email: Data from frontend (replyTo object):", replyTo);
    console.log("--------------------");

    const recipient = to || (bcc && bcc.length > 0 ? senderEmail : null);

    if (!recipient || !subject || !text) {
        console.error("Validation failed: Missing fields for /send-email.");
        return res.status(400).json({ error: 'Missing required fields: to/bcc, subject, text' });
    }

    const formattedFrom = `State 48 Theatre <${senderEmail}>`;

    let formattedReplyTo;
    if (replyTo && replyTo.email && replyTo.name) {
        formattedReplyTo = `${replyTo.name} <${replyTo.email}>`;
    } else {
        formattedReplyTo = formattedFrom;
    }

    const resendPayload = {
        to: recipient,
        bcc: bcc || undefined,
        from: formattedFrom,
        replyTo: formattedReplyTo, // Use camelCase
        subject: subject,
        text: text,
    };

    console.log("DEBUG /send-email: Final payload for Resend:", JSON.stringify(resendPayload, null, 2));
    console.log("--------------------");

    try {
        console.log("Attempting to send email via Resend...");
        const { data, error } = await resend.emails.send(resendPayload);

        if (error) {
            console.error('Resend Error:', error);
            return res.status(500).json({ error: 'Failed to send email. Check server logs.' });
        }

        console.log(`Email sent successfully. ID: ${data.id}, Subject: ${subject}`);
        res.status(200).json({ message: 'Email sent successfully!' });

    } catch (error) {
        console.error('Server Error during email send:', error);
        res.status(500).json({ error: 'Failed to send email. Check server logs.' });
    }
}); // <-- End of /send-email route

// --- Create Stripe Invoice Route (with Pre-Finalization Check) ---
app.post('/create-invoice', authenticateToken, isAdmin, async (req, res) => {
    const { parentId, studentName, amount, description } = req.body;
    const adminUid = req.user.uid;

    console.log("--------------------");
    console.log("DEBUG /create-invoice: Received data:", { parentId, studentName, amount, description });

    console.log(`Admin ${adminUid} attempting to create invoice for parent ID: ${parentId}`);

    if (!parentId || !amount || !description || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        console.error("Create invoice validation failed: Missing fields or invalid amount.");
        return res.status(400).json({ error: 'Parent ID, Description, and a valid positive Amount required.' });
    }

    const amountInCents = Math.round(parseFloat(amount) * 100);
    console.log(`DEBUG /create-invoice: Calculated amountInCents: ${amountInCents}`);
    console.log("--------------------");

    if (amountInCents === 0 && parseFloat(amount) > 0) {
         console.error(`CRITICAL ERROR: amountInCents calculated as 0 for input amount ${amount}. Aborting.`);
         return res.status(500).json({ error: 'Internal server error: Failed to calculate invoice amount correctly.'});
    }

    let parentRef;

    try {
        // --- 1. Get Parent Info ---
        parentRef = admin.firestore().doc(`organizations/${organizationId}/parents/${parentId}`);
        const parentSnap = await parentRef.get();
        if (!parentSnap.exists) {
            throw new Error(`Parent with ID ${parentId} not found in Firestore.`);
        }
        const parentData = parentSnap.data();
        const parentEmail = parentData.email;
        const parentName = parentData.name;
        let stripeCustomerId = parentData.stripeCustomerId;

        // --- 2. Find or Create Stripe Customer ---
        if (!stripeCustomerId) {
            console.log(`No Stripe customer ID found for parent ${parentId}. Creating one...`);
            const existingCustomers = await stripe.customers.list({ email: parentEmail, limit: 1 });
            if (existingCustomers.data.length > 0) {
                 stripeCustomerId = existingCustomers.data[0].id;
                 console.log(`Found existing Stripe customer by email: ${stripeCustomerId}`);
            } else {
                 const customer = await stripe.customers.create({
                     name: parentName,
                     email: parentEmail,
                     metadata: { firestoreParentId: parentId, organizationId: organizationId }
                 });
                 stripeCustomerId = customer.id;
                 console.log(`Created new Stripe customer: ${stripeCustomerId}`);
            }
            await parentRef.update({ stripeCustomerId: stripeCustomerId });
            console.log(`Saved Stripe customer ID ${stripeCustomerId} to Firestore parent ${parentId}`);
        } else {
            console.log(`Using existing Stripe customer ID: ${stripeCustomerId} for parent ${parentId}`);
        }

        // --- 3. Create Invoice Item ---
        console.log(`Creating invoice item for customer ${stripeCustomerId}, amount: ${amountInCents}`);
        const invoiceItem = await stripe.invoiceItems.create({
            customer: stripeCustomerId,
            amount: amountInCents,
            currency: 'usd',
            description: description,
            metadata: { studentName: studentName || 'N/A' }
        });
        console.log(`Created invoice item: ${invoiceItem.id}`);

        // --- 4. Create Draft Invoice ---
        console.log(`Creating draft invoice for customer ${stripeCustomerId}`);
        const draftInvoice = await stripe.invoices.create({
            customer: stripeCustomerId,
            collection_method: 'send_invoice',
            days_until_due: 30,
            auto_advance: false, // Keep as draft
            description: `Invoice for ${studentName || parentName}`,
            metadata: { firestoreParentId: parentId, createdByAdminUid: adminUid }
        });
        console.log(`Created draft invoice: ${draftInvoice.id}`);

        // --- *** PRE-FINALIZATION CHECK *** ---
        const retrievedDraft = await stripe.invoices.retrieve(draftInvoice.id);
        console.log(`DEBUG: Retrieved draft invoice ${retrievedDraft.id}. Status: ${retrievedDraft.status}, Total: ${retrievedDraft.total}`);
        if (retrievedDraft.total !== amountInCents && retrievedDraft.total !== 0) { // Allow 0 if credit balance covers it
             console.warn(`WARNING: Draft invoice total (${retrievedDraft.total}) does not match expected item amount (${amountInCents}). Item might not have attached correctly or credit applied.`);
        } else if (retrievedDraft.total === 0 && amountInCents > 0) {
             console.log(`DEBUG: Draft invoice total is 0. This might be due to an existing credit balance. Proceeding with finalization.`);
        }
        // --- *** END CHECK *** ---


        // --- 5. Finalize the Invoice ---
        console.log(`Finalizing invoice: ${draftInvoice.id}`);
        // Add idempotency key to prevent accidental double finalization
        const finalizedInvoice = await stripe.invoices.finalizeInvoice(draftInvoice.id, {
          idempotencyKey: `finalize-${draftInvoice.id}-${Date.now()}` // Basic idempotency
        });
        console.log(`Finalized invoice: ${finalizedInvoice.id}, Status: ${finalizedInvoice.status}, Final Amount Due: ${finalizedInvoice.amount_due}`);

        // --- Check Final Status ---
        if (finalizedInvoice.status === 'paid' && finalizedInvoice.amount_due === 0 && amountInCents > 0) {
             console.warn(`WARNING: Invoice ${finalizedInvoice.id} finalized as paid with $0 due, but item amount was ${amountInCents}. Check Stripe Dashboard for credits or other items.`);
        } else if (finalizedInvoice.status === 'open' && finalizedInvoice.amount_due === amountInCents) {
             console.log(`Invoice ${finalizedInvoice.id} finalized correctly with status 'open' and amount due ${finalizedInvoice.amount_due}.`);
        } else if (finalizedInvoice.status === 'paid' && finalizedInvoice.amount_due === 0 && amountInCents === 0){
             console.log(`Invoice ${finalizedInvoice.id} finalized correctly as paid with $0 amount.`);
        } else {
             console.log(`Invoice ${finalizedInvoice.id} finalized with status ${finalizedInvoice.status} and amount due ${finalizedInvoice.amount_due}.`);
        }


        // --- Respond to Frontend ---
        res.status(200).json({
            message: 'Invoice created successfully!',
            invoiceId: finalizedInvoice.id,
            invoiceStatus: finalizedInvoice.status,
            invoiceUrl: finalizedInvoice.hosted_invoice_url
        });

    } catch (error) {
        console.error('Stripe Invoice Creation Error:', error);
        // Consider adding more specific error handling if needed
        res.status(500).json({ error: `Failed to create invoice. ${error.message}` });
    }
}); // <-- End of /create-invoice route


// --- User Management Routes (Protected by Auth and Admin) ---

// List Users
app.get('/list-users', authenticateToken, isAdmin, async (req, res) => {
    console.log(`User ${req.user.uid} requesting user list.`);
    try {
        const listUsersResult = await admin.auth().listUsers(1000);
        const users = listUsersResult.users.map(userRecord => ({
            uid: userRecord.uid,
            email: userRecord.email,
            displayName: userRecord.displayName, // Include displayName
            isAdmin: userRecord.customClaims?.admin === true
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
    const { name, email, password } = req.body;
    console.log(`Admin ${req.user.uid} attempting to create user: ${name} (${email})`);

    if (!name || !email || !password || password.length < 6) {
        console.error("Create user validation failed: Invalid name, email, or password length.");
        return res.status(400).json({ error: 'Name, valid email, and password (min 6 chars) required.' });
    }
    try {
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: name
        });
        console.log(`Successfully created user: ${userRecord.email} (UID: ${userRecord.uid})`);
        res.status(201).json({ uid: userRecord.uid, email: userRecord.email });
    } catch (error) {
        console.error('Error creating user:', error);
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

// --- Update User Name ---
app.post('/update-user-name', authenticateToken, isAdmin, async (req, res) => {
    const { uid, newName } = req.body;
    const adminUid = req.user.uid;

    console.log(`Admin ${adminUid} attempting to update name for UID: ${uid} to "${newName}"`);

    if (!uid || !newName || typeof newName !== 'string' || newName.trim().length === 0) {
        console.error("Update name validation failed: Missing UID or newName.");
        return res.status(400).json({ error: 'User ID (uid) and a non-empty new name required.' });
    }

    try {
        await admin.auth().updateUser(uid, {
            displayName: newName.trim()
        });
        console.log(`Successfully updated display name for user: ${uid}`);

        const updatedSelf = uid === adminUid;

        res.status(200).json({
            message: 'User display name updated successfully.',
            updatedSelf: updatedSelf
        });

    } catch (error) {
        console.error(`Error updating name for user ${uid}:`, error);
        let errorMessage = 'Failed to update display name.';
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
        let canSetAdmin = false;
        if (req.user.admin === true) {
            canSetAdmin = true;
            console.log("Requesting user is an admin.");
        } else if (uidToMakeAdmin === requestingUserUid) {
            console.log("Requesting user trying to make self admin. Checking if any admins exist...");
            const listUsersResult = await admin.auth().listUsers(10);
            const existingAdmins = listUsersResult.users.filter(u => u.customClaims?.admin === true);
            if (existingAdmins.length === 0) {
                canSetAdmin = true;
                console.log("No existing admins found. Allowing bootstrap.");
            } else {
                 console.log("Existing admins found. Bootstrap disallowed.");
            }
        }

        if (!canSetAdmin) {
             console.log("Set admin permission denied.");
             return res.status(403).json({ error: 'Admin privileges required or bootstrap condition not met.' });
        }

        await admin.auth().setCustomUserClaims(uidToMakeAdmin, { admin: true });
        console.log(`Successfully set admin claim for user: ${uidToMakeAdmin}`);
        res.status(200).json({ message: 'Admin privileges granted. User must sign out and back in for changes to take effect.' });

    } catch (error) {
        console.error(`Error setting admin claim for ${uidToMakeAdmin}:`, error);
        let errorMessage = 'Failed to set admin privileges.';
        if (error.code === 'auth/user-not-found') {
            errorMessage = 'Target user not found.';
        }
        res.status(500).json({ error: errorMessage });
    }
});


// --- Start Server ---
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});