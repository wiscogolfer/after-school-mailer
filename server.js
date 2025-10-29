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
    console.warn('WARNING: ORGANIZATION_ID environment variable not set. Using default:', organizationId);
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
app.post('/send-email', authenticateToken, async (req, res) => {
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
        to: recipient, bcc: bcc || undefined, from: formattedFrom,
        replyTo: formattedReplyTo, subject: subject, text: text,
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

// --- Create Stripe Invoice Route (Student-Centric) ---
app.post('/create-invoice', authenticateToken, isAdmin, async (req, res) => {
    const { parentId, studentId, studentName, amount, description } = req.body;
    const adminUid = req.user.uid;

    console.log("--------------------");
    console.log("DEBUG /create-invoice: Received data:", { parentId, studentId, studentName, amount, description });

    if (!parentId || !studentId || !studentName || !amount || !description || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        console.error("Create invoice validation failed: Missing fields or invalid amount.");
        return res.status(400).json({ error: 'Parent ID, Student ID, Student Name, Description, and a valid positive Amount required.' });
    }

    const amountInCents = Math.round(parseFloat(amount) * 100);
    console.log(`DEBUG /create-invoice: Calculated amountInCents: ${amountInCents}`);
    console.log("--------------------");

    if (amountInCents === 0 && parseFloat(amount) > 0) {
         console.error(`CRITICAL ERROR: amountInCents calculated as 0 for input amount ${amount}. Aborting.`);
         return res.status(500).json({ error: 'Internal server error: Failed to calculate invoice amount correctly.'});
    }

    let studentRef;
    let createdInvoiceItemId = null;
    let draftInvoiceId = null;

    try {
        // --- 1. Get Student AND Parent Info ---
        studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);
        const studentSnap = await studentRef.get();
        if (!studentSnap.exists) { // <-- CORRECT ADMIN SDK SYNTAX
            throw new Error(`Student ${studentId} not found.`);
        }
        
        const parentRef = admin.firestore().doc(`organizations/${organizationId}/parents/${parentId}`);
        const parentSnap = await parentRef.get();
        if (!parentSnap.exists) { // <-- CORRECT ADMIN SDK SYNTAX
            throw new Error(`Parent ${parentId} not found.`);
        }
        
        const studentData = studentSnap.data();
        const parentData = parentSnap.data();
        
        const billingEmail = parentData.email;
        const customerName = studentData.name || studentName; 
        let stripeCustomerId = studentData.stripeCustomerId;

        // --- 2. Find or Create Stripe Customer (for the STUDENT) ---
        if (!stripeCustomerId) {
            console.log(`No Stripe customer ID found for student ${studentId}. Creating/Finding...`);
            
            let customer;
            const existingCustomers = await stripe.customers.list({ email: billingEmail, limit: 10 });
            
            const matchingCustomer = existingCustomers.data.find(c => c.name === customerName);

            if (matchingCustomer) {
                 stripeCustomerId = matchingCustomer.id;
                 console.log(`Found existing Stripe customer by name/email: ${stripeCustomerId}`);
            } else {
                 console.log(`Creating new Stripe customer for student ${customerName} with email ${billingEmail}`);
                 customer = await stripe.customers.create({
                     name: customerName, // STUDENT'S NAME
                     email: billingEmail, // PARENT'S EMAIL
                     metadata: { 
                         firestoreStudentId: studentId, 
                         firestoreParentId: parentId, 
                         organizationId: organizationId 
                     }
                 });
                 stripeCustomerId = customer.id;
                 console.log(`Created new Stripe customer: ${stripeCustomerId}`);
            }
            
            await studentRef.update({ stripeCustomerId: stripeCustomerId });
            console.log(`Saved Stripe ID ${stripeCustomerId} to Firestore STUDENT ${studentId}`);
        } else {
            console.log(`Using existing Stripe customer ID: ${stripeCustomerId} for student ${studentId}`);
        }

        // --- 3. Create Draft Invoice ---
        console.log(`Creating draft invoice for customer ${stripeCustomerId}`);
        const draftInvoice = await stripe.invoices.create({
            customer: stripeCustomerId,
            collection_method: 'send_invoice',
            days_until_due: 30,
            auto_advance: false, // Keep as draft
            description: `Invoice for ${customerName}`,
            metadata: { firestoreStudentId: studentId, firestoreParentId: parentId, createdByAdminUid: adminUid }
        });
        draftInvoiceId = draftInvoice.id;
        console.log(`Created draft invoice: ${draftInvoice.id}`);

        // --- 4. Create Invoice Item *and Attach* ---
        console.log(`Creating invoice item and attaching to ${draftInvoice.id}, amount: ${amountInCents}`);
        const invoiceItem = await stripe.invoiceItems.create({
            customer: stripeCustomerId,
            amount: amountInCents,
            currency: 'usd',
            description: description,
            metadata: { studentName: customerName },
            invoice: draftInvoice.id // <-- THE FIX
        });
        createdInvoiceItemId = invoiceItem.id;
        console.log(`Created invoice item: ${createdInvoiceItemId}`);

        // --- 5. PRE-FINALIZATION CHECK ---
        const retrievedDraft = await stripe.invoices.retrieve(draftInvoice.id);
        console.log(`DEBUG: Retrieved draft invoice ${retrievedDraft.id}. Status: ${retrievedDraft.status}, Total: ${retrievedDraft.total}`);
        if (retrievedDraft.total === 0 && amountInCents > 0) {
             throw new Error("Invoice item did not attach to the draft invoice. Aborting finalization.");
        }

        // --- 6. Finalize the Invoice ---
        console.log(`Finalizing invoice: ${draftInvoice.id}`);
        const finalizedInvoice = await stripe.invoices.finalizeInvoice(draftInvoice.id, {
          idempotencyKey: `finalize-${draftInvoice.id}-${Date.now()}`
        });
        console.log(`Finalized invoice: ${finalizedInvoice.id}, Status: ${finalizedInvoice.status}, Final Amount Due: ${finalizedInvoice.amount_due}`);

        // --- Respond to Frontend ---
        res.status(200).json({
            message: 'Invoice created successfully!',
            invoiceId: finalizedInvoice.id,
            invoiceStatus: finalizedInvoice.status,
            invoiceUrl: finalizedInvoice.hosted_invoice_url
        });

    } catch (error) {
        console.error('Stripe Invoice Creation Error:', error);
        // Cleanup logic
        if (createdInvoiceItemId) {
             try { await stripe.invoiceItems.del(createdInvoiceItemId); console.log(`Deleted orphaned item ${createdInvoiceItemId}`); } 
             catch (e) { console.error(`Failed to delete orphaned item ${createdInvoiceItemId}:`, e.message); }
        }
        if (draftInvoiceId) {
             try { await stripe.invoices.del(draftInvoiceId); console.log(`Deleted draft invoice ${draftInvoiceId}`); } 
             catch (e) { console.error(`Failed to delete draft invoice ${draftInvoiceId}:`, e.message); }
        }
        if (!res.headersSent) {
             res.status(500).json({ error: `Failed to create invoice. ${error.message}` });
        }
    }
}); // <-- End of /create-invoice route


// --- *** CORRECTED *** Get Student's Stripe Invoices ---
app.get('/get-student-invoices/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params;
    console.log(`Fetching invoices for student: ${studentId}`);

    try {
        // 1. Get the student document from Firestore (from the root collection)
        const studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);
        const studentSnap = await studentRef.get();

        // --- THIS IS THE FIX ---
        // Use the property .exists (no parentheses) for the Admin SDK
        if (!studentSnap.exists) { 
            console.warn(`Student not found: ${studentId}`);
            return res.status(404).json({ error: 'Student not found.' });
        }

        const stripeCustomerId = studentSnap.data().stripeCustomerId;

        // 2. Check if the student is mapped to Stripe
        if (!stripeCustomerId) {
            console.log(`Student ${studentId} has no stripeCustomerId. Returning empty list.`);
            return res.status(200).json({ invoices: [] }); // No ID means no invoices
        }

        // 3. Fetch invoices from Stripe
        console.log(`Fetching invoices from Stripe for customer: ${stripeCustomerId}`);
        const invoices = await stripe.invoices.list({
            customer: stripeCustomerId,
            limit: 50,
            expand: ['data.lines'] 
        });

        // 4. Send the invoice data to the frontend
        res.status(200).json({ invoices: invoices.data });

    } catch (error) {
        console.error(`Error fetching invoices for student ${studentId}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch invoices.' });
    }
}); // <-- End of /get-student-invoices route


// --- *** CORRECTED *** Get Student's Stripe Subscriptions ---
app.get('/get-student-subscriptions/:studentId', authenticateToken, async (req, res) => {
    const { studentId } = req.params;
    console.log(`Fetching subscriptions for student: ${studentId}`);

    try {
        // 1. Get the student document from Firestore (from the root collection)
        const studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);
        const studentSnap = await studentRef.get();

        // --- THIS IS THE FIX ---
        // Use the property .exists (no parentheses) for the Admin SDK
        if (!studentSnap.exists) {
            console.warn(`Student not found: ${studentId}`);
            return res.status(404).json({ error: 'Student not found.' });
        }

        const stripeCustomerId = studentSnap.data().stripeCustomerId;

        // 2. Check if the student is mapped to Stripe
        if (!stripeCustomerId) {
            console.log(`Student ${studentId} has no stripeCustomerId. Returning empty list.`);
            return res.status(200).json({ subscriptions: [] }); // No ID means no subscriptions
        }

        // 3. Fetch active subscriptions from Stripe
        console.log(`Fetching subscriptions from Stripe for customer: ${stripeCustomerId}`);
        const subscriptions = await stripe.subscriptions.list({
            customer: stripeCustomerId,
            status: 'all',
            limit: 20
        });

        // 4. Send the subscription data to the frontend
        res.status(200).json({ subscriptions: subscriptions.data });

    } catch (error) {
        console.error(`Error fetching subscriptions for student ${studentId}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch subscriptions.' });
    }
}); // <-- End of /get-student-subscriptions route


// --- Admin: Sync Firestore Students with Stripe Customers (Corrected) ---
app.post('/admin/sync-stripe-customers', authenticateToken, isAdmin, async (req, res) => {
    console.log('--- Starting Stripe Customer Sync (Student-Centric) ---');
    
    try {
        const parentsRef = admin.firestore().collection(`organizations/${organizationId}/parents`);
        const parentsSnap = await parentsRef.get();

        if (parentsSnap.empty) {
            console.log('No parents found to sync.');
            return res.status(200).json({ message: 'No parents found.' });
        }

        // Create a map of all parents by their email for efficient lookup
        const parentEmailMap = new Map();
        for (const parentDoc of parentsSnap.docs) {
            const parentData = parentDoc.data();
            if (parentData.email) {
                parentEmailMap.set(parentDoc.id, parentData.email);
            }
        }
        
        const studentsRef = admin.firestore().collection(`organizations/${organizationId}/students`);
        const studentsSnap = await studentsRef.get();

        if (studentsSnap.empty) {
            console.log('No students found to sync.');
            return res.status(200).json({ message: 'No students found.' });
        }

        let updatedCount = 0;
        let notFoundCount = 0;
        const promises = [];

        // Loop through every student
        for (const studentDoc of studentsSnap.docs) {
            const studentData = studentDoc.data();
            const studentId = studentDoc.id;
            const studentName = studentData.name;
            const parentIds = studentData.parents || [];
            
            // Try to find the student's billing email from their first parent
            const primaryParentId = parentIds.length > 0 ? parentIds[0] : null;
            const billingEmail = primaryParentId ? parentEmailMap.get(primaryParentId) : null;

            // Only process students who are NOT already mapped and HAVE a name and parent email
            if (!studentData.stripeCustomerId && studentName && billingEmail) {
                
                const promise = stripe.customers.list({ email: billingEmail, limit: 10 })
                    .then(async (existingCustomers) => {
                        // Find a customer with this parent's email AND this student's name
                        const matchingCustomer = existingCustomers.data.find(c => c.name === studentName);

                        if (matchingCustomer) {
                            // --- Customer Found ---
                            const stripeId = matchingCustomer.id;
                            console.log(`MATCH: Student ${studentId} (${studentName}) -> Stripe ${stripeId}`);
                            
                            // Save the ID back to Firestore
                            await studentDoc.ref.update({ stripeCustomerId: stripeId });
                            updatedCount++;
                        } else {
                            // --- No Customer Found ---
                            console.log(`NO MATCH: Student ${studentId} (${studentName}) with email ${billingEmail} has no matching Stripe customer.`);
                            notFoundCount++;
                        }
                    })
                    .catch(err => {
                        console.error(`Error syncing student ${studentId}:`, err.message);
                    });
                
                promises.push(promise);
            }
        }

        // Wait for all updates to finish
        await Promise.all(promises);

        const summary = `Sync complete. ${updatedCount} students updated. ${notFoundCount} students had no matching Stripe customer.`;
        console.log(summary);
        res.status(200).json({ message: summary, updated: updatedCount, notFound: notFoundCount });

    } catch (error) {
        console.error('Error during Stripe customer sync:', error.message);
        res.status(500).json({ error: 'Sync failed. Check server logs.' });
    }
}); // <-- End of /admin/sync-stripe-customers route


// --- User Management Routes (Protected by Auth and Admin) ---

// List Users
app.get('/list-users', authenticateToken, isAdmin, async (req, res) => {
    console.log(`User ${req.user.uid} requesting user list.`);
    try {
        const listUsersResult = await admin.auth().listUsers(1000);
        const users = listUsersResult.users.map(userRecord => ({
            uid: userRecord.uid,
            email: userRecord.email,
            displayName: userRecord.displayName,
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
        // --- TYPO FIX: 5G00 -> 500 ---
        res.status(500).json({ error: errorMessage });
    }
});

// --- *** NEW *** Manually Map Stripe Customer ID ---
app.post('/map-stripe-customer', authenticateToken, isAdmin, async (req, res) => {
    const { studentId, stripeCustomerId } = req.body;

    console.log(`Manual map request: Student ${studentId} -> Stripe ${stripeCustomerId}`);

    if (!studentId || !stripeCustomerId || !stripeCustomerId.startsWith('cus_')) {
        return res.status(400).json({ error: 'Valid Student ID and Stripe Customer ID (cus_...) required.' });
    }

    try {
        const studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);

        // Optional: Verify the Stripe Customer ID exists in Stripe
        try {
            await stripe.customers.retrieve(stripeCustomerId);
            console.log(`Stripe customer ${stripeCustomerId} verified.`);
        } catch (stripeError) {
            if (stripeError.type === 'StripeInvalidRequestError') {
                 console.warn(`Stripe customer ${stripeCustomerId} not found.`);
                 return res.status(400).json({ error: `Stripe Customer ID "${stripeCustomerId}" not found.` });
            }
             throw stripeError; // Re-throw other Stripe errors
        }

        // Update Firestore
        await studentRef.update({ stripeCustomerId: stripeCustomerId });

        console.log(`Successfully mapped student ${studentId} to ${stripeCustomerId}`);
        res.status(200).json({ message: 'Stripe Customer ID mapped successfully!' });

    } catch (error) {
        console.error(`Error mapping Stripe ID for student ${studentId}:`, error.message);
        res.status(500).json({ error: 'Failed to map Stripe Customer ID.' });
    }
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});