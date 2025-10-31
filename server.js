// server.js (ESM)

// ===== existing imports (keep) =====
import express from "express";
import cors from "cors";
import "dotenv/config";
import { Resend } from "resend";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// >>> NEW: Stripe + Firestore
import Stripe from "stripe";
import { getFirestore, doc, getDoc, setDoc, updateDoc } from "firebase-admin/firestore";

// ===== Firebase Admin init (keep your fixed version) =====
function getServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}
const svc = getServiceAccountFromEnv();
if (!getApps().length) {
  if (!svc?.project_id) {
    console.error('Firebase init failed: Service account object must contain a string "project_id" property.');
  } else {
    initializeApp({ credential: cert(svc), projectId: svc.project_id });
    console.log("Firebase Admin initialized:", svc.project_id);
  }
}
const db = getFirestore();

// ===== Express app (keep) =====
const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== CORS (keep but ensure your origins are here) =====
const allowedOrigins = new Set([
  "https://classesapp.state48arts.org",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
  })
);

// ===== Health (keep) =====
app.get("/", (_req, res) => res.json({ ok: true }));

// ===== Resend mailer (keep your working route) =====
const resend = new Resend(process.env.RESEND_API_KEY);
app.post("/send-email", async (req, res) => {
  try {
    const { to, bcc, subject, text, replyTo } = req.body || {};
    if ((!to && (!bcc || !bcc.length)) || !subject || !text) {
      return res.status(400).json({ error: "Missing to/bcc, subject, or text" });
    }
    const fromAddress = process.env.FROM_EMAIL || "contact@state48theatre.com";
    const toList = to ? [to] : [process.env.DEFAULT_TO || fromAddress];
    const payload = { from: fromAddress, to: toList, subject, text };
    if (Array.isArray(bcc) && bcc.length) payload.bcc = bcc;
    if (replyTo?.email) {
      payload.reply_to = replyTo.name ? `${replyTo.name} <${replyTo.email}>` : replyTo.email;
    }
    const result = await resend.emails.send(payload);
    if (result?.error) return res.status(500).json({ error: String(result.error) });
    res.json({ ok: true, id: result?.id || null });
  } catch (err) {
    console.error("send-email error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Auth helpers (keep) =====
async function verifyBearer(req) {
  const h = req.get("Authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) throw new Error("Missing bearer token");
  return await getAuth().verifyIdToken(t);
}
async function requireAdmin(req) {
  const decoded = await verifyBearer(req);
  if (!decoded.admin) throw new Error("Admin privileges required");
  return decoded;
}

// ===== Admin endpoints (keep yours) =====
// ... list-users, create-user, delete-user, set-admin, update-user-name ...

// ------------------------------------------------------------------------------------
// >>> NEW: Stripe multi-org setup
// Env vars: STRIPE_KEY_ORG_A, STRIPE_KEY_ORG_B (you can name them), STRIPE_WEBHOOK_SECRET_ORG_A, STRIPE_WEBHOOK_SECRET_ORG_B
// Also define what orgId strings you use on the frontend. Example below matches your HTML config org "State-48-Dance".
const STRIPE_KEYS_BY_ORG = {
  "State-48-Dance": process.env.STRIPE_KEY_ORG_A,
  "State-48-Theatre": process.env.STRIPE_KEY_ORG_B,
};

const STRIPE_WEBHOOK_SECRETS = {
  "State-48-Dance": process.env.STRIPE_WEBHOOK_SECRET_ORG_A,
  "State-48-Theatre": process.env.STRIPE_WEBHOOK_SECRET_ORG_B,
};

function getStripe(orgId) {
  const key = STRIPE_KEYS_BY_ORG[orgId];
  if (!orgId || !key) throw new Error("Unknown org or missing Stripe key");
  return new Stripe(key, { apiVersion: "2024-06-20" });
}

// Helpers to locate Firestore student doc
function studentDocRef(orgId, studentId) {
  return doc(db, `organizations/${orgId}/students/${studentId}`);
}
function customerIndexRef(orgId, customerId) {
  return doc(db, `organizations/${orgId}/stripeCustomers/${customerId}`);
}

// --- Search customers by email/name ---
app.get("/stripe/search-customers", async (req, res) => {
  try {
    await verifyBearer(req); // any signed-in user can search
    const { orgId, q } = req.query;
    if (!orgId || !q) return res.status(400).json({ error: "orgId and q are required" });
    const stripe = getStripe(orgId);
    // Stripe search syntax: https://docs.stripe.com/search#supported-fields
    // We’ll search email or name loosely
    const query = `email:'${q}' OR name:'${q}'`;
    const results = await stripe.customers.search({ query, limit: 10 });
    res.json({
      data: results.data.map((c) => ({
        id: c.id,
        email: c.email || null,
        name: c.name || null,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Map a student to a Stripe customer (and create reverse index) ---
app.post("/stripe/map-customer", async (req, res) => {
  try {
    await verifyBearer(req); // any signed in user
    const { orgId, studentId, customerId } = req.body || {};
    if (!orgId || !studentId || !customerId)
      return res.status(400).json({ error: "orgId, studentId, customerId required" });

    const sRef = studentDocRef(orgId, studentId);
    const sSnap = await getDoc(sRef);
    if (!sSnap.exists()) return res.status(404).json({ error: "Student not found" });

    // store mapping on student
    await setDoc(
      sRef,
      { stripe: { customers: { [orgId]: customerId } } },
      { merge: true }
    );

    // reverse index for webhooks
    await setDoc(customerIndexRef(orgId, customerId), { studentId }, { merge: true });

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Create & send an invoice ---
app.post("/stripe/create-invoice", async (req, res) => {
  try {
    await verifyBearer(req);
    const { orgId, studentId, amount, description } = req.body || {};
    if (!orgId || !studentId || !amount || !description)
      return res.status(400).json({ error: "orgId, studentId, amount, description required" });

    const stripe = getStripe(orgId);

    // Find customer mapping on student
    const sSnap = await getDoc(studentDocRef(orgId, studentId));
    if (!sSnap.exists()) return res.status(404).json({ error: "Student not found" });
    const student = sSnap.data();
    const customerId =
      student?.stripe?.customers?.[orgId] ||
      null;

    if (!customerId) return res.status(400).json({ error: "Student not mapped to a Stripe customer for this org" });

    // Create an Invoice Item (amount in cents)
    await stripe.invoiceItems.create({
      customer: customerId,
      currency: "usd",
      amount: Math.round(Number(amount) * 100),
      description,
    });

    // Create & finalize invoice
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: "send_invoice",
      days_until_due: 7,
      description,
    });
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id, {});

    // Send via Stripe (emails the customer)
    const sent = await stripe.invoices.sendInvoice(finalized.id);

    // Optional: write a lightweight history record
    await setDoc(
      doc(db, `organizations/${orgId}/students/${studentId}/billing/invoices/${sent.id}`),
      {
        createdAt: Date.now(),
        amount: sent.total,
        currency: sent.currency,
        status: sent.status,
        hostedInvoiceUrl: sent.hosted_invoice_url || null,
        number: sent.number || null,
        description,
      },
      { merge: true }
    );

    res.json({
      ok: true,
      invoiceId: sent.id,
      hostedInvoiceUrl: sent.hosted_invoice_url || null,
      status: sent.status,
    });
  } catch (err) {
    console.error("create-invoice error:", err);
    res.status(400).json({ error: err.message });
  }
});

// --- List invoices for a customer ---
app.get("/stripe/list-invoices", async (req, res) => {
  try {
    await verifyBearer(req);
    const { orgId, customerId } = req.query || {};
    if (!orgId || !customerId)
      return res.status(400).json({ error: "orgId and customerId required" });
    const stripe = getStripe(orgId);
    const list = await stripe.invoices.list({ customer: customerId, limit: 20 });
    res.json({
      data: list.data.map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        total: i.total,
        currency: i.currency,
        hostedInvoiceUrl: i.hosted_invoice_url,
        created: i.created * 1000,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- List subscriptions for a customer ---
app.get("/stripe/list-subscriptions", async (req, res) => {
  try {
    await verifyBearer(req);
    const { orgId, customerId } = req.query || {};
    if (!orgId || !customerId)
      return res.status(400).json({ error: "orgId and customerId required" });
    const stripe = getStripe(orgId);
    const list = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
    res.json({
      data: list.data.map((s) => ({
        id: s.id,
        status: s.status,
        items: s.items.data.map((it) => ({
          priceId: it.price.id,
          product: it.price.product,
          unitAmount: it.price.unit_amount,
          currency: it.price.currency,
          interval: it.price.recurring?.interval || null,
        })),
        currentPeriodEnd: s.current_period_end * 1000,
        cancelAtPeriodEnd: s.cancel_at_period_end,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Webhook per org (optional, recommended) ---
// Set "Use raw body" ONLY for this route or mount a raw body parser.
import bodyParser from "body-parser";
app.post("/stripe/webhook/:orgId", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const orgId = req.params.orgId;
  const whSecret = STRIPE_WEBHOOK_SECRETS[orgId];
  if (!whSecret) return res.status(400).send("Missing webhook secret for org");

  const stripe = getStripe(orgId);
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
  } catch (e) {
    console.error("Webhook signature verify failed:", e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    // Persist minimal history
    if (event.type.startsWith("invoice.")) {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const idx = await getDoc(customerIndexRef(orgId, customerId));
      const studentId = idx.exists() ? idx.data().studentId : null;
      if (studentId) {
        await setDoc(
          doc(db, `organizations/${orgId}/students/${studentId}/billing/invoices/${invoice.id}`),
          {
            lastEventAt: Date.now(),
            status: invoice.status,
            total: invoice.total,
            currency: invoice.currency,
            hostedInvoiceUrl: invoice.hosted_invoice_url || null,
            number: invoice.number || null,
          },
          { merge: true }
        );
      }
    }
    // you can add subscription.* handling similarly
  } catch (e) {
    console.error("Webhook handling error:", e);
    // still return 200 so Stripe won't retry forever if it's a data edge case
  }

  res.json({ received: true });
});

// ===== Listen (keep) =====
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
