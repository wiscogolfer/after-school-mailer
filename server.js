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
const organizationId = process.env.ORGANIZATION_ID || "State-48-Dance"; // Get Org ID or use default

// --- NEW: Stripe Secret Keys (Must be set in Render environment variables) ---
const stripeSecretKeyHalleDance = process.env.STRIPE_SECRET_KEY_HALLE_DANCE;
const stripeSecretKeyState48Arts = process.env.STRIPE_SECRET_KEY_STATE48ARTS_ORG; // Use _ORG for env var

// --- NEW: Stripe Account Identifiers (Match Firestore keys and Frontend) ---
const ACCOUNT_ID_HALLE = 'halle_dance';
const ACCOUNT_ID_STATE48 = 'state48arts.org';

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
if (!stripeSecretKeyHalleDance) {
    console.error('FATAL ERROR: STRIPE_SECRET_KEY_HALLE_DANCE environment variable is not set.');
    process.exit(1);
}
if (!stripeSecretKeyState48Arts) {
    console.error('FATAL ERROR: STRIPE_SECRET_KEY_STATE48ARTS_ORG environment variable is not set.');
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

console.log("Stripe library loaded. Instances will be created dynamically.");


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

// --- Helper Function to Get Stripe Instance ---
const getStripeInstance = (accountIdentifier) => {
    let selectedSecretKey;
    if (accountIdentifier === ACCOUNT_ID_HALLE) {
        selectedSecretKey = stripeSecretKeyHalleDance;
    } else if (accountIdentifier === ACCOUNT_ID_STATE48) {
        selectedSecretKey = stripeSecretKeyState48Arts;
    } else {
        throw new Error(`Invalid account identifier provided: ${accountIdentifier}`);
    }

    if (!selectedSecretKey) {
        throw new Error(`Missing Stripe secret key environment variable for ${accountIdentifier}`);
    }
    // Return a new Stripe instance initialized with the correct key
    return Stripe(selectedSecretKey);
};


// --- API Routes ---

// Test Route (Optional)
app.get('/', (req, res) => {
    res.send('After School Mailer Server is running!');
});

// --- Email Sending Route ---
app.post('/send-email', authenticateToken, async (req, res) => {
    const { to, bcc, subject, text, replyTo } = req.body;
    const recipient = to || (bcc && bcc.length > 0 ? senderEmail : null);
    if (!recipient || !subject || !text) {
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
    try {
        const { data, error } = await resend.emails.send(resendPayload);
        if (error) {
            return res.status(500).json({ error: 'Failed to send email. Check server logs.' });
        }
        res.status(200).json({ message: 'Email sent successfully!' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send email. Check server logs.' });
    }
}); // <-- End of /send-email route

// --- Create Stripe Invoice Route (Multi-Account) ---
app.post('/create-invoice', authenticateToken, isAdmin, async (req, res) => {
    const { parentId, studentId, studentName, amount, description, accountIdentifier } = req.body;
    const adminUid = req.user.uid;

    console.log("--------------------");
    console.log("DEBUG /create-invoice: Received data:", { parentId, studentId, studentName, amount, description, accountIdentifier });

    // Validate accountIdentifier
    if (accountIdentifier !== ACCOUNT_ID_HALLE && accountIdentifier !== ACCOUNT_ID_STATE48) {
        return res.status(400).json({ error: 'Invalid business account specified.' });
    }
    // Basic validation for other fields
    if (!parentId || !studentId || !studentName || !amount || !description || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
         return res.status(400).json({ error: 'Parent ID, Student ID, Student Name, Description, Account, and a valid positive Amount required.' });
    }
    const amountInCents = Math.round(parseFloat(amount) * 100);
    if (amountInCents === 0 && parseFloat(amount) > 0) {
         return res.status(500).json({ error: 'Internal server error: Failed to calculate invoice amount correctly.'});
    }

    let studentRef;
    let createdInvoiceItemId = null;
    let draftInvoiceId = null;
    let stripeForAccount; // Variable to hold the dynamic Stripe instance

    try {
        // --- Get Stripe instance for the target account ---
        stripeForAccount = getStripeInstance(accountIdentifier);

        // --- 1. Get Student AND Parent Info ---
        studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);
        const studentSnap = await studentRef.get();
        if (!studentSnap.exists) throw new Error(`Student ${studentId} not found.`);

        const parentRef = admin.firestore().doc(`organizations/${organizationId}/parents/${parentId}`);
        const parentSnap = await parentRef.get();
        if (!parentSnap.exists) throw new Error(`Parent ${parentId} not found.`);

        const studentData = studentSnap.data();
        const parentData = parentSnap.data();
        const billingEmail = parentData.email;
        const customerName = studentData.name || studentName;

        // --- 2. Get/Create Stripe Customer ID *for this account* ---
        // Ensure stripeInfo is initialized to an empty object if undefined
        const stripeInfo = studentData.stripeInfo || {};
        let stripeCustomerId = stripeInfo[accountIdentifier]; 
        
        if (!stripeCustomerId) {
            let customer;
            const existingCustomers = await stripeForAccount.customers.list({ email: billingEmail, limit: 10 });
            const matchingCustomer = existingCustomers.data.find(c => c.name === customerName);

            if (matchingCustomer) {
                stripeCustomerId = matchingCustomer.id;
            } else {
                customer = await stripeForAccount.customers.create({
                    name: customerName,
                    email: billingEmail,
                    metadata: {
                        firestoreStudentId: studentId,
                        firestoreParentId: parentId,
                        organizationId: organizationId
                    }
                });
                stripeCustomerId = customer.id;
            }

            // --- IMPORTANT: Update Firestore map ---
            const updateData = {};
            updateData[`stripeInfo.${accountIdentifier}`] = stripeCustomerId;
            await studentRef.update(updateData);
        }

        // --- 3. Create Draft Invoice (using specific Stripe instance) ---
        const draftInvoice = await stripeForAccount.invoices.create({
            customer: stripeCustomerId,
            collection_method: 'send_invoice',
            days_until_due: 30,
            auto_advance: false,
            description: `Invoice for ${customerName}`,
            metadata: { firestoreStudentId: studentId, firestoreParentId: parentId, createdByAdminUid: adminUid, account: accountIdentifier }
        });
        draftInvoiceId = draftInvoice.id;

        // --- 4. Create Invoice Item *and Attach* (using specific Stripe instance) ---
        const invoiceItem = await stripeForAccount.invoiceItems.create({
            customer: stripeCustomerId,
            amount: amountInCents,
            currency: 'usd',
            description: description,
            metadata: { studentName: customerName },
            invoice: draftInvoice.id
        });
        createdInvoiceItemId = invoiceItem.id;

        // --- 5. PRE-FINALIZATION CHECK (using specific Stripe instance) ---
        const retrievedDraft = await stripeForAccount.invoices.retrieve(draftInvoice.id);
        if (retrievedDraft.total === 0 && amountInCents > 0) {
            throw new Error("Invoice item did not attach. Aborting finalization.");
        }

        // --- 6. Finalize the Invoice (using specific Stripe instance) ---
        const finalizedInvoice = await stripeForAccount.invoices.finalizeInvoice(draftInvoice.id, {
          idempotencyKey: `finalize-${draftInvoice.id}-${Date.now()}`
        });

        res.status(200).json({ 
            message: 'Invoice created successfully!',
            invoiceId: finalizedInvoice.id,
            invoiceStatus: finalizedInvoice.status,
            invoiceUrl: finalizedInvoice.hosted_invoice_url
        });

    } catch (error) {
        console.error(`Stripe Invoice Creation Error on account ${accountIdentifier || 'unknown'}:`, error);
        // --- Cleanup Logic (Needs account-specific Stripe instance!) ---
        if (stripeForAccount && createdInvoiceItemId) {
             try { await stripeForAccount.invoiceItems.del(createdInvoiceItemId); }
             catch (e) { console.error(`Failed delete item ${createdInvoiceItemId}:`, e.message); }
        }
        if (stripeForAccount && draftInvoiceId) {
             try { await stripeForAccount.invoices.del(draftInvoiceId); }
             catch (e) { console.error(`Failed delete draft ${draftInvoiceId}:`, e.message); }
        }
        if (!res.headersSent) {
             res.status(500).json({ error: `Failed create invoice. ${error.message}` });
        }
    }
}); // <-- End of /create-invoice route


// --- Get Student's Stripe Invoices (Multi-Account) ---
app.get('/get-student-invoices/:studentId/:accountIdentifier', authenticateToken, async (req, res) => {
    const { studentId, accountIdentifier } = req.params; 

    if (accountIdentifier !== ACCOUNT_ID_HALLE && accountIdentifier !== ACCOUNT_ID_STATE48) {
        return res.status(400).json({ error: 'Invalid account identifier specified.' });
    }

    try {
        const stripeForAccount = getStripeInstance(accountIdentifier);

        const studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);
        const studentSnap = await studentRef.get();
        // --- FIX: Use .exists property ---
        if (!studentSnap.exists) { 
            return res.status(404).json({ error: 'Student not found.' });
        }
        const studentData = studentSnap.data();

        const stripeCustomerId = studentData.stripeInfo?.[accountIdentifier];

        if (!stripeCustomerId) {
            return res.status(200).json({ invoices: [] });
        }

        const invoices = await stripeForAccount.invoices.list({
            customer: stripeCustomerId,
            limit: 50,
            expand: ['data.lines']
        });

        res.status(200).json({ invoices: invoices.data });

    } catch (error) {
        console.error(`Error fetching invoices for student ${studentId} on account ${accountIdentifier}:`, error.message);
        if (error.message.startsWith('Missing Stripe secret key')) {
             res.status(500).json({ error: 'Server configuration error.' });
        } else if (error.message.startsWith('Invalid account identifier')) {
            res.status(400).json({ error: 'Invalid account identifier.' });
        } else {
             res.status(500).json({ error: 'Failed to fetch invoices.' });
        }
    }
}); // <-- End of /get-student-invoices route


// --- Get Student's Stripe Subscriptions (Multi-Account) ---
app.get('/get-student-subscriptions/:studentId/:accountIdentifier', authenticateToken, async (req, res) => {
    const { studentId, accountIdentifier } = req.params;

    if (accountIdentifier !== ACCOUNT_ID_HALLE && accountIdentifier !== ACCOUNT_ID_STATE48) {
        return res.status(400).json({ error: 'Invalid account identifier specified.' });
    }

    try {
        const stripeForAccount = getStripeInstance(accountIdentifier);

        const studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);
        const studentSnap = await studentRef.get();
        // --- FIX: Use .exists property ---
        if (!studentSnap.exists) {
            return res.status(404).json({ error: 'Student not found.' });
        }
        const studentData = studentSnap.data();

        const stripeCustomerId = studentData.stripeInfo?.[accountIdentifier];

        if (!stripeCustomerId) {
            return res.status(200).json({ subscriptions: [] });
        }

        const subscriptions = await stripeForAccount.subscriptions.list({
            customer: stripeCustomerId,
            status: 'all',
            limit: 20
        });

        res.status(200).json({ subscriptions: subscriptions.data });

    } catch (error) {
        console.error(`Error fetching subscriptions for student ${studentId} on account ${accountIdentifier}:`, error.message);
        if (error.message.startsWith('Missing Stripe secret key')) {
             res.status(500).json({ error: 'Server configuration error.' });
        } else if (error.message.startsWith('Invalid account identifier')) {
            res.status(400).json({ error: 'Invalid account identifier.' });
        } else {
             res.status(500).json({ error: 'Failed to fetch subscriptions.' });
        }
    }
}); // <-- End of /get-student-subscriptions route


// --- Admin: Sync Firestore Students with Stripe Customers (Multi-Account) ---
app.post('/admin/sync-stripe-customers', authenticateToken, isAdmin, async (req, res) => {
    console.log('--- Starting Stripe Customer Sync (Multi-Account) ---');

    try {
        const parentsRef = admin.firestore().collection(`organizations/${organizationId}/parents`);
        const parentsSnap = await parentsRef.get();

        const parentEmailMap = new Map();
        parentsSnap.docs.forEach(doc => {
            if (doc.data().email) parentEmailMap.set(doc.id, doc.data().email);
        });

        const studentsRef = admin.firestore().collection(`organizations/${organizationId}/students`);
        const studentsSnap = await studentsRef.get();

        let updatedCount = 0;
        let notFoundCount = 0;
        const promises = [];
        const accountsToSync = [
            { id: ACCOUNT_ID_HALLE, key: stripeSecretKeyHalleDance },
            { id: ACCOUNT_ID_STATE48, key: stripeSecretKeyState48Arts }
        ];

        // Loop through each student in Firestore
        for (const studentDoc of studentsSnap.docs) {
            const studentData = studentDoc.data();
            const studentId = studentDoc.id;
            const studentName = studentData.name;
            const parentIds = studentData.parents || [];
            const primaryParentId = parentIds.length > 0 ? parentIds[0] : null;
            const billingEmail = primaryParentId ? parentEmailMap.get(primaryParentId) : null;

            if (!studentName || !billingEmail) {
                continue; // Skip if essential info is missing
            }

            // Loop through each Stripe account configuration
            for (const account of accountsToSync) {
                const accountIdentifier = account.id;

                // Check if already mapped for this account
                if (!(studentData.stripeInfo?.[accountIdentifier])) {
                    
                    try {
                        const stripeForAccount = Stripe(account.key); // Use specific key
                        const promise = stripeForAccount.customers.list({ email: billingEmail, limit: 10 })
                            .then(async (existingCustomers) => {
                                const matchingCustomer = existingCustomers.data.find(c => c.name === studentName);
                                if (matchingCustomer) {
                                    const stripeId = matchingCustomer.id;
                                    const updateData = {};
                                    updateData[`stripeInfo.${accountIdentifier}`] = stripeId;
                                    await studentDoc.ref.update(updateData);
                                    updatedCount++;
                                } else {
                                    notFoundCount++; // Increment per account check
                                }
                            })
                            .catch(err => {
                                console.error(`Error syncing student ${studentId} on account ${accountIdentifier}:`, err.message);
                            });
                        promises.push(promise);
                    } catch (initError) {
                         console.error(`Error initializing Stripe for account ${accountIdentifier}:`, initError.message);
                    }
                }
            } // End loop through accounts
        } // End loop through students

        await Promise.all(promises);

        const summary = `Sync complete. ${updatedCount} mappings updated/created.`;
        res.status(200).json({ message: summary, updated: updatedCount });

    } catch (error) {
        console.error('Error during Stripe customer sync:', error.message);
        res.status(500).json({ error: 'Sync failed. Check server logs.' });
    }
}); // <-- End of /admin/sync-stripe-customers route

// --- Manually Map Stripe Customer ID (Multi-Account) ---
app.post('/map-stripe-customer', authenticateToken, isAdmin, async (req, res) => {
    const { studentId, stripeCustomerId, accountIdentifier } = req.body;

    if (accountIdentifier !== ACCOUNT_ID_HALLE && accountIdentifier !== ACCOUNT_ID_STATE48) {
        return res.status(400).json({ error: 'Invalid business account specified.' });
    }
    if (!studentId || !stripeCustomerId || !stripeCustomerId.startsWith('cus_')) {
        return res.status(400).json({ error: 'Valid Student ID and Stripe Customer ID (cus_...) required.' });
    }

    try {
        const stripeForAccount = getStripeInstance(accountIdentifier);
        const studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);

        // Verify the Stripe Customer ID exists in the SPECIFIED Stripe account
        try {
            await stripeForAccount.customers.retrieve(stripeCustomerId);
        } catch (stripeError) {
            if (stripeError.type === 'StripeInvalidRequestError') {
                 return res.status(400).json({ error: `Stripe Customer ID "${stripeCustomerId}" not found in ${accountIdentifier}.` });
            }
             throw stripeError;
        }

        // Update Firestore map using Field Path notation
        const updateData = {};
        updateData[`stripeInfo.${accountIdentifier}`] = stripeCustomerId;
        await studentRef.update(updateData);

        res.status(200).json({ message: 'Stripe Customer ID mapped successfully!' });

    } catch (error) {
        console.error(`Error mapping Stripe ID for student ${studentId} on account ${accountIdentifier}:`, error.message);
        if (error.message.startsWith('Missing Stripe secret key')) {
             res.status(500).json({ error: 'Server configuration error.' });
        } else {
             res.status(500).json({ error: 'Failed to map Stripe Customer ID.' });
        }
    }
}); // <-- End of /map-stripe-customer route

// --- User Management Routes ---
app.get('/list-users', authenticateToken, isAdmin, async (req, res) => {
    try {
        const listUsersResult = await admin.auth().listUsers(1000);
        const users = listUsersResult.users.map(userRecord => ({
            uid: userRecord.uid, email: userRecord.email, displayName: userRecord.displayName, isAdmin: userRecord.customClaims?.admin === true
        }));
        res.status(200).json({ users });
    } catch (error) {
        res.status(500).json({ error: 'Failed to list users.' });
    }
});

app.post('/create-user', authenticateToken, isAdmin, async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 6) {
        return res.status(400).json({ error: 'Name, valid email, and password (min 6 chars) required.' });
    }
    try {
        const userRecord = await admin.auth().createUser({ email: email, password: password, displayName: name });
        res.status(201).json({ uid: userRecord.uid, email: userRecord.email });
    } catch (error) {
        let errorMessage = 'Failed to create user.';
        if (error.code === 'auth/email-already-exists') {
            errorMessage = 'Email address is already in use.';
        } else if (error.code === 'auth/invalid-password') {
             errorMessage = 'Password must be at least 6 characters long.';
        }
        res.status(500).json({ error: errorMessage });
    }
});

app.post('/delete-user', authenticateToken, isAdmin, async (req, res) => {
    const { uid } = req.body;
    if (!uid) {
        return res.status(400).json({ error: 'User ID (uid) required.' });
    }
    if (uid === req.user.uid) {
        return res.status(400).json({ error: 'Admin cannot delete their own account.' });
    }
    try {
        await admin.auth().deleteUser(uid);
        res.status(200).json({ message: 'User deleted successfully.' });
    } catch (error) {
        let errorMessage = 'Failed to delete user.';
        if (error.code === 'auth/user-not-found') {
            errorMessage = 'User not found.';
        }
        res.status(500).json({ error: errorMessage });
    }
});

app.post('/update-user-name', authenticateToken, isAdmin, async (req, res) => {
    const { uid, newName } = req.body;
    const adminUid = req.user.uid;

    if (!uid || !newName || typeof newName !== 'string' || newName.trim().length === 0) {
        return res.status(400).json({ error: 'User ID (uid) and a non-empty new name required.' });
    }

    try {
        await admin.auth().updateUser(uid, {
            displayName: newName.trim()
        });
        const updatedSelf = uid === adminUid;
        res.status(200).json({ message: 'User display name updated successfully.', updatedSelf: updatedSelf });
    } catch (error) {
        let errorMessage = 'Failed to update display name.';
        if (error.code === 'auth/user-not-found') {
            errorMessage = 'User not found.';
        }
        res.status(500).json({ error: errorMessage });
    }
});

app.post('/set-admin', authenticateToken, async (req, res) => {
    const { uidToMakeAdmin } = req.body;
    const requestingUserUid = req.user.uid;

    if (!uidToMakeAdmin) {
        return res.status(400).json({ error: 'Target User ID (uidToMakeAdmin) required.' });
    }

    try {
        let canSetAdmin = false;
        if (req.user.admin === true) {
            canSetAdmin = true;
        } else if (uidToMakeAdmin === requestingUserUid) {
            const listUsersResult = await admin.auth().listUsers(10);
            const existingAdmins = listUsersResult.users.filter(u => u.customClaims?.admin === true);
            if (existingAdmins.length === 0) {
                canSetAdmin = true;
            }
        }

        if (!canSetAdmin) {
             return res.status(403).json({ error: 'Admin privileges required or bootstrap condition not met.' });
        }

        await admin.auth().setCustomUserClaims(uidToMakeAdmin, { admin: true });
        res.status(200).json({ message: 'Admin privileges granted. User must sign out and back in for changes to take effect.' });

    } catch (error) {
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