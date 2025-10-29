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
// --- REMOVED single stripeSecretKey reference ---
const organizationId = process.env.ORGANIZATION_ID || "State-48-Dance"; // Get Org ID or use default

// --- NEW: Stripe Secret Keys ---
const stripeSecretKeyHalleDance = process.env.STRIPE_SECRET_KEY_HALLE_DANCE;
const stripeSecretKeyState48Arts = process.env.STRIPE_SECRET_KEY_STATE48ARTS_ORG; // Use _ORG for env var

// --- NEW: Stripe Account Identifiers (Match Firestore keys) ---
const ACCOUNT_ID_HALLE = 'halle_dance';
const ACCOUNT_ID_STATE48 = 'state48arts.org';

// Validate critical environment variables
if (!serviceAccountKeyBase64) { /* ... */ }
if (!resendApiKey) { /* ... */ }
if (!senderEmail) { /* ... */ }
// --- NEW: Validate BOTH Stripe keys ---
if (!stripeSecretKeyHalleDance) {
    console.error('FATAL ERROR: STRIPE_SECRET_KEY_HALLE_DANCE environment variable is not set.');
    process.exit(1);
}
if (!stripeSecretKeyState48Arts) {
    console.error('FATAL ERROR: STRIPE_SECRET_KEY_STATE48ARTS_ORG environment variable is not set.');
    process.exit(1);
}
if (!organizationId) { /* ... */ }

// Decode the base64 service account key
let serviceAccount;
try {
    const serviceAccountJson = Buffer.from(serviceAccountKeyBase64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(serviceAccountJson);
} catch (error) { /* ... */ }


// --- Firebase Admin Initialization ---
try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) { /* ... */ }

// --- Resend Initialization ---
const resend = new Resend(resendApiKey);
console.log("Resend configured.");

// --- Stripe Initialization (No longer needed globally for requests) ---
// const stripe = Stripe(stripeSecretKey); // REMOVED
console.log("Stripe library loaded. Instances will be created dynamically.");


// --- Express App Setup ---
const app = express();
const port = process.env.PORT || 3000; // Render provides the PORT env var

// --- Middleware ---
app.use(cors()); // Enable CORS for all origins
app.use(express.json()); // Parse JSON request bodies

// --- Authentication Middleware ---
const authenticateToken = async (req, res, next) => { /* ... */ };

// --- Admin Check Middleware ---
const isAdmin = (req, res, next) => { /* ... */ };

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
app.get('/', (req, res) => { /* ... */ });

// --- Email Sending Route ---
app.post('/send-email', authenticateToken, async (req, res) => { /* ... */ });

// --- *** UPDATED *** Create Stripe Invoice Route (Multi-Account) ---
app.post('/create-invoice', authenticateToken, isAdmin, async (req, res) => {
    // Frontend MUST send accountIdentifier
    const { parentId, studentId, studentName, amount, description, accountIdentifier } = req.body;
    const adminUid = req.user.uid;

    console.log("--------------------");
    console.log("DEBUG /create-invoice: Received data:", { parentId, studentId, studentName, amount, description, accountIdentifier });

    // Validate accountIdentifier
    if (accountIdentifier !== ACCOUNT_ID_HALLE && accountIdentifier !== ACCOUNT_ID_STATE48) {
        console.error("Create invoice validation failed: Invalid accountIdentifier.");
        return res.status(400).json({ error: 'Invalid business account specified.' });
    }
    // Basic validation for other fields
    if (!parentId || !studentId || !studentName || !amount || !description || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
         console.error("Create invoice validation failed: Missing fields or invalid amount.");
         return res.status(400).json({ error: 'Parent ID, Student ID, Student Name, Description, Account, and a valid positive Amount required.' });
    }
    const amountInCents = Math.round(parseFloat(amount) * 100);
    if (amountInCents === 0 && parseFloat(amount) > 0) { /* ... handle zero amount error ... */ }

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
        let stripeCustomerId = studentData.stripeInfo?.[accountIdentifier]; // Get ID specific to this account
        let isNewCustomer = false;

        if (!stripeCustomerId) {
            console.log(`No Stripe customer ID found for student ${studentId} on account ${accountIdentifier}. Creating/Finding...`);
            isNewCustomer = true;
            let customer;
            // Use the account-specific Stripe instance
            const existingCustomers = await stripeForAccount.customers.list({ email: billingEmail, limit: 10 });
            const matchingCustomer = existingCustomers.data.find(c => c.name === customerName);

            if (matchingCustomer) {
                stripeCustomerId = matchingCustomer.id;
                console.log(`Found existing Stripe customer by name/email: ${stripeCustomerId} on account ${accountIdentifier}`);
            } else {
                console.log(`Creating new Stripe customer for student ${customerName} with email ${billingEmail} on account ${accountIdentifier}`);
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
                console.log(`Created new Stripe customer: ${stripeCustomerId}`);
            }

            // --- IMPORTANT: Update Firestore map ---
            // Use Field Path notation or template literal to update nested map field
            const updateData = {};
            updateData[`stripeInfo.${accountIdentifier}`] = stripeCustomerId; // e.g., stripeInfo.halle_dance = "cus_..."
            await studentRef.update(updateData);
            console.log(`Saved Stripe ID ${stripeCustomerId} to Firestore STUDENT ${studentId} for account ${accountIdentifier}`);

        } else {
            console.log(`Using existing Stripe customer ID: ${stripeCustomerId} for student ${studentId} on account ${accountIdentifier}`);
        }

        // --- 3. Create Draft Invoice (using specific Stripe instance) ---
        console.log(`Creating draft invoice for customer ${stripeCustomerId} on account ${accountIdentifier}`);
        const draftInvoice = await stripeForAccount.invoices.create({
            customer: stripeCustomerId,
            collection_method: 'send_invoice',
            days_until_due: 30,
            auto_advance: false,
            description: `Invoice for ${customerName}`,
            metadata: { firestoreStudentId: studentId, firestoreParentId: parentId, createdByAdminUid: adminUid, account: accountIdentifier }
        });
        draftInvoiceId = draftInvoice.id;
        console.log(`Created draft invoice: ${draftInvoice.id}`);

        // --- 4. Create Invoice Item *and Attach* (using specific Stripe instance) ---
        console.log(`Creating invoice item and attaching to ${draftInvoice.id}, amount: ${amountInCents}`);
        const invoiceItem = await stripeForAccount.invoiceItems.create({
            customer: stripeCustomerId,
            amount: amountInCents,
            currency: 'usd',
            description: description,
            metadata: { studentName: customerName },
            invoice: draftInvoice.id
        });
        createdInvoiceItemId = invoiceItem.id;
        console.log(`Created invoice item: ${createdInvoiceItemId}`);

        // --- 5. PRE-FINALIZATION CHECK (using specific Stripe instance) ---
        const retrievedDraft = await stripeForAccount.invoices.retrieve(draftInvoice.id);
        console.log(`DEBUG: Retrieved draft invoice ${retrievedDraft.id}. Status: ${retrievedDraft.status}, Total: ${retrievedDraft.total}`);
        if (retrievedDraft.total === 0 && amountInCents > 0) {
            throw new Error("Invoice item did not attach. Aborting finalization.");
        }

        // --- 6. Finalize the Invoice (using specific Stripe instance) ---
        console.log(`Finalizing invoice: ${draftInvoice.id}`);
        const finalizedInvoice = await stripeForAccount.invoices.finalizeInvoice(draftInvoice.id, {
          idempotencyKey: `finalize-${draftInvoice.id}-${Date.now()}`
        });
        console.log(`Finalized invoice: ${finalizedInvoice.id}, Status: ${finalizedInvoice.status}, Final Amount Due: ${finalizedInvoice.amount_due}`);

        res.status(200).json({ /* ... response ... */ });

    } catch (error) {
        console.error(`Stripe Invoice Creation Error on account ${accountIdentifier || 'unknown'}:`, error);
        // --- Cleanup Logic (Needs account-specific Stripe instance!) ---
        if (stripeForAccount && createdInvoiceItemId) {
             try { await stripeForAccount.invoiceItems.del(createdInvoiceItemId); console.log(`Deleted item ${createdInvoiceItemId}`); }
             catch (e) { console.error(`Failed delete item ${createdInvoiceItemId}:`, e.message); }
        }
        if (stripeForAccount && draftInvoiceId) {
             try { await stripeForAccount.invoices.del(draftInvoiceId); console.log(`Deleted draft ${draftInvoiceId}`); }
             catch (e) { console.error(`Failed delete draft ${draftInvoiceId}:`, e.message); }
        }
        if (!res.headersSent) {
             res.status(500).json({ error: `Failed create invoice. ${error.message}` });
        }
    }
}); // <-- End of /create-invoice route


// --- *** UPDATED *** Get Student's Stripe Invoices (Multi-Account) ---
// Frontend MUST call: GET /get-student-invoices/:studentId/:accountIdentifier
app.get('/get-student-invoices/:studentId/:accountIdentifier', authenticateToken, async (req, res) => {
    const { studentId, accountIdentifier } = req.params; // Get both IDs

    console.log(`Fetching invoices for student: ${studentId} on account: ${accountIdentifier}`);

    // Validate accountIdentifier
    if (accountIdentifier !== ACCOUNT_ID_HALLE && accountIdentifier !== ACCOUNT_ID_STATE48) {
        return res.status(400).json({ error: 'Invalid account identifier specified.' });
    }

    try {
        // --- Get Stripe instance ---
        const stripeForAccount = getStripeInstance(accountIdentifier);

        // 1. Get student data
        const studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);
        const studentSnap = await studentRef.get();
        if (!studentSnap.exists) {
            return res.status(404).json({ error: 'Student not found.' });
        }
        const studentData = studentSnap.data();

        // 2. Get the correct Stripe Customer ID from the map
        const stripeCustomerId = studentData.stripeInfo?.[accountIdentifier];

        if (!stripeCustomerId) {
            console.log(`Student ${studentId} has no Stripe Customer ID for account ${accountIdentifier}.`);
            return res.status(200).json({ invoices: [] });
        }

        // 3. Make the API call using the specific Stripe instance
        console.log(`Fetching invoices for customer ${stripeCustomerId} using key for ${accountIdentifier}`);
        const invoices = await stripeForAccount.invoices.list({
            customer: stripeCustomerId,
            limit: 50,
            expand: ['data.lines']
        });

        res.status(200).json({ invoices: invoices.data });

    } catch (error) {
        console.error(`Error fetching invoices for student ${studentId} on account ${accountIdentifier}:`, error.message);
        // Distinguish config errors from other errors
        if (error.message.startsWith('Missing Stripe secret key')) {
             res.status(500).json({ error: 'Server configuration error.' });
        } else if (error.message.startsWith('Invalid account identifier')) {
            res.status(400).json({ error: 'Invalid account identifier.' });
        } else {
             res.status(500).json({ error: 'Failed to fetch invoices.' });
        }
    }
}); // <-- End of /get-student-invoices route


// --- *** UPDATED *** Get Student's Stripe Subscriptions (Multi-Account) ---
// Frontend MUST call: GET /get-student-subscriptions/:studentId/:accountIdentifier
app.get('/get-student-subscriptions/:studentId/:accountIdentifier', authenticateToken, async (req, res) => {
    const { studentId, accountIdentifier } = req.params;

    console.log(`Fetching subscriptions for student: ${studentId} on account: ${accountIdentifier}`);

    if (accountIdentifier !== ACCOUNT_ID_HALLE && accountIdentifier !== ACCOUNT_ID_STATE48) {
        return res.status(400).json({ error: 'Invalid account identifier specified.' });
    }

    try {
        // --- Get Stripe instance ---
        const stripeForAccount = getStripeInstance(accountIdentifier);

        // 1. Get student data
        const studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);
        const studentSnap = await studentRef.get();
        if (!studentSnap.exists) {
            return res.status(404).json({ error: 'Student not found.' });
        }
        const studentData = studentSnap.data();

        // 2. Get the correct Stripe Customer ID
        const stripeCustomerId = studentData.stripeInfo?.[accountIdentifier];

        if (!stripeCustomerId) {
            console.log(`Student ${studentId} has no Stripe Customer ID for account ${accountIdentifier}.`);
            return res.status(200).json({ subscriptions: [] });
        }

        // 3. Make the API call
        console.log(`Fetching subscriptions for customer ${stripeCustomerId} using key for ${accountIdentifier}`);
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


// --- *** UPDATED *** Admin: Sync Firestore Students with Stripe Customers (Multi-Account) ---
app.post('/admin/sync-stripe-customers', authenticateToken, isAdmin, async (req, res) => {
    console.log('--- Starting Stripe Customer Sync (Multi-Account) ---');

    try {
        const parentsRef = admin.firestore().collection(`organizations/${organizationId}/parents`);
        const parentsSnap = await parentsRef.get();
        if (parentsSnap.empty) { /* ... handle no parents ... */ }

        const parentEmailMap = new Map();
        parentsSnap.docs.forEach(doc => {
            if (doc.data().email) parentEmailMap.set(doc.id, doc.data().email);
        });

        const studentsRef = admin.firestore().collection(`organizations/${organizationId}/students`);
        const studentsSnap = await studentsRef.get();
        if (studentsSnap.empty) { /* ... handle no students ... */ }

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
                console.warn(`Skipping student ${studentId}: Missing name or parent email.`);
                continue; // Skip if essential info is missing
            }

            // Loop through each Stripe account configuration
            for (const account of accountsToSync) {
                const accountIdentifier = account.id;

                // Only sync if this student IS NOT already mapped for THIS account
                if (!studentData.stripeInfo?.[accountIdentifier]) {
                    console.log(`Checking account ${accountIdentifier} for student ${studentId} (${studentName})...`);
                    try {
                        const stripeForAccount = Stripe(account.key); // Use specific key
                        const promise = stripeForAccount.customers.list({ email: billingEmail, limit: 10 })
                            .then(async (existingCustomers) => {
                                const matchingCustomer = existingCustomers.data.find(c => c.name === studentName);
                                if (matchingCustomer) {
                                    const stripeId = matchingCustomer.id;
                                    console.log(`MATCH: Student ${studentId} -> Stripe ${stripeId} ON ACCOUNT ${accountIdentifier}`);
                                    const updateData = {};
                                    updateData[`stripeInfo.${accountIdentifier}`] = stripeId;
                                    await studentDoc.ref.update(updateData);
                                    updatedCount++;
                                } else {
                                    console.log(`NO MATCH: Student ${studentId} (${studentName}) on account ${accountIdentifier}.`);
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

        const summary = `Sync complete. ${updatedCount} mappings updated/created. ${notFoundCount} potential matches not found (across all account checks).`;
        console.log(summary);
        res.status(200).json({ message: summary, updated: updatedCount, notFound: notFoundCount });

    } catch (error) {
        console.error('Error during Stripe customer sync:', error.message);
        res.status(500).json({ error: 'Sync failed. Check server logs.' });
    }
}); // <-- End of /admin/sync-stripe-customers route

// --- *** UPDATED *** Manually Map Stripe Customer ID (Multi-Account) ---
app.post('/map-stripe-customer', authenticateToken, isAdmin, async (req, res) => {
    // Frontend MUST send accountIdentifier
    const { studentId, stripeCustomerId, accountIdentifier } = req.body;

    console.log(`Manual map request: Student ${studentId} -> Stripe ${stripeCustomerId} on account ${accountIdentifier}`);

    // Validate accountIdentifier
    if (accountIdentifier !== ACCOUNT_ID_HALLE && accountIdentifier !== ACCOUNT_ID_STATE48) {
        return res.status(400).json({ error: 'Invalid business account specified.' });
    }
    if (!studentId || !stripeCustomerId || !stripeCustomerId.startsWith('cus_')) {
        return res.status(400).json({ error: 'Valid Student ID and Stripe Customer ID (cus_...) required.' });
    }

    try {
        // --- Get Stripe instance ---
        const stripeForAccount = getStripeInstance(accountIdentifier);
        const studentRef = admin.firestore().doc(`organizations/${organizationId}/students/${studentId}`);

        // Verify the Stripe Customer ID exists in the SPECIFIED Stripe account
        try {
            await stripeForAccount.customers.retrieve(stripeCustomerId);
            console.log(`Stripe customer ${stripeCustomerId} verified on account ${accountIdentifier}.`);
        } catch (stripeError) { /* ... handle Stripe not found error ... */ }

        // Update Firestore map using Field Path notation
        const updateData = {};
        updateData[`stripeInfo.${accountIdentifier}`] = stripeCustomerId;
        await studentRef.update(updateData);

        console.log(`Successfully mapped student ${studentId} to ${stripeCustomerId} for account ${accountIdentifier}`);
        res.status(200).json({ message: 'Stripe Customer ID mapped successfully!' });

    } catch (error) {
        console.error(`Error mapping Stripe ID for student ${studentId} on account ${accountIdentifier}:`, error.message);
        if (error.message.startsWith('Missing Stripe secret key')) {
             res.status(500).json({ error: 'Server configuration error.' });
        } else if (error.message.startsWith('Invalid account identifier')) {
            res.status(400).json({ error: 'Invalid account identifier.' });
        } else {
             res.status(500).json({ error: 'Failed to map Stripe Customer ID.' });
        }
    }
}); // <-- End of /map-stripe-customer route

// --- User Management Routes ---
app.get('/list-users', authenticateToken, isAdmin, async (req, res) => { /* ... unchanged ... */ });
app.post('/create-user', authenticateToken, isAdmin, async (req, res) => { /* ... unchanged ... */ });
app.post('/delete-user', authenticateToken, isAdmin, async (req, res) => { /* ... unchanged ... */ });
app.post('/update-user-name', authenticateToken, isAdmin, async (req, res) => { /* ... unchanged ... */ });
app.post('/set-admin', authenticateToken, async (req, res) => { /* ... unchanged (already had 500 error fix) ... */ });

// --- Start Server ---
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});