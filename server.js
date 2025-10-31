// server.js (ESM)

import express from "express";
import cors from "cors";
import "dotenv/config";
import { Resend } from "resend";

// Firebase Admin
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// Stripe
import Stripe from "stripe";

// Raw body ONLY for Stripe webhook
import bodyParser from "body-parser";

// ---------- Firebase Admin init ----------
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

// ---------- Express app ----------
const app = express();

// ⚠️ Put the Stripe webhook BEFORE express.json() so the raw body is available
app.post(
  "/stripe/webhook/:orgId",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const orgId = req.params.orgId;
      const STRIPE_WEBHOOK_SECRETS = {
        "State-48-Dance": process.env.STRIPE_WEBHOOK_SECRET_ORG_A,
        "State-48-Theatre": process.env.STRIPE_WEBHOOK_SECRET_ORG_B,
      };
      const whSecret = STRIPE_WEBHOOK_SECRETS[orgId];
      if (!whSecret) return res.status(400).send("Missing webhook secret for org");

      const STRIPE_KEYS_BY_ORG = {
        "State-48-Dance": process.env.STRIPE_KEY_ORG_A,
        "State-48-Theatre": process.env.STRIPE_KEY_ORG_B,
      };
      const key = STRIPE_KEYS_BY_ORG[orgId];
      if (!key) return res.status(400).send("Missing Stripe key for org");
      const stripe = new Stripe(key, { apiVersion: "2024-06-20" });

      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
      } catch (e) {
        console.error("Webhook signature verify failed:", e.message);
        return res.status(400).send(`Webhook Error: ${e.message}`);
      }

      // Minimal persistence for invoices
      if (event.type.startsWith("invoice.")) {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        // reverse-index doc at organizations/{orgId}/stripeCustomers/{customerId}
        const idxRef = db.doc(`organizations/${orgId}/stripeCustomers/${customerId}`);
        const idxSnap = await idxRef.get();
        const studentId = idxSnap.exists ? idxSnap.data().studentId : null;

        if (studentId) {
          const invRef = db.doc(
            `organizations/${orgId}/students/${studentId}/billing/invoices/${invoice.id}`
          );
          await invRef.set(
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

      return res.json({ received: true });
    } catch (e) {
      console.error("Webhook handling error:", e);
      // Acknowledge to avoid endless retries; log for investigation
      return res.json({ received: true });
    }
  }
);

// Now JSON body parser for all *other* routes
app.use(express.json({ limit: "2mb" }));

// CORS
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

// Health
app.get("/", (_req, res) => res.json({ ok: true }));

// Resend mailer
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

// Auth helpers
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

// ---------- Stripe multi-org helpers ----------
const STRIPE_KEYS_BY_ORG = {
  "State-48-Dance": process.env.STRIPE_KEY_ORG_A,
  "State-48-Theatre": process.env.STRIPE_KEY_ORG_B,
};

function getStripe(orgId) {
  const key = STRIPE_KEYS_BY_ORG[orgId];
  if (!orgId || !key) throw new Error("Unknown org or missing Stripe key");
  return new Stripe(key, { apiVersion: "2024-06-20" });
}

// Firestore refs (Admin SDK style)
function studentRef(orgId, studentId) {
  return db.doc(`organizations/${orgId}/students/${studentId}`);
}
function customerIndexRef(orgId, customerId) {
  return db.doc(`organizations/${orgId}/stripeCustomers/${customerId}`);
}

// --- Search customers by email/name ---
app.get("/stripe/search-customers", async (req, res) => {
  try {
    await verifyBearer(req);
    const { orgId, q } = req.query;
    if (!orgId || !q) return res.status(400).json({ error: "orgId and q are required" });
    const stripe = getStripe(orgId);
    const query = `email:'${q}' OR name:'${q}'`; // Stripe search syntax
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
    await verifyBearer(req);
    const { orgId, studentId, customerId } = req.body || {};
    if (!orgId || !studentId || !customerId)
      return res.status(400).json({ error: "orgId, studentId, customerId required" });

    const sRef = studentRef(orgId, studentId);
    const sSnap = await sRef.get();
    if (!sSnap.exists) return res.status(404).json({ error: "Student not found" });

    await sRef.set(
      { stripe: { customers: { [orgId]: customerId } } },
      { merge: true }
    );

    await customerIndexRef(orgId, customerId).set({ studentId }, { merge: true });

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

    // Get student mapping
    const sSnap = await studentRef(orgId, studentId).get();
    if (!sSnap.exists) return res.status(404).json({ error: "Student not found" });
    const student = sSnap.data();
    const customerId = student?.stripe?.customers?.[orgId] || null;
    if (!customerId) return res.status(400).json({ error: "Student not mapped to a Stripe customer for this org" });

    // Create invoice item (amount in cents)
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
    const sent = await stripe.invoices.sendInvoice(finalized.id);

    // Persist history
    const invRef = db.doc(
      `organizations/${orgId}/students/${studentId}/billing/invoices/${sent.id}`
    );
    await invRef.set(
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

// --- List invoices ---
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

// --- List subscriptions ---
app.get("/stripe/list-subscriptions", async (req, res) => {
  try {
    await verifyBearer(req);
    const { orgId, customerId } = req.query || {};
    if (!orgId || !customerId)
      return res.status(400).json({ error: "orgId and customerId required" });
    const stripe = getStripe(orgId);
    const list = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 20,
    });
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

// ---------- Start server ----------
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
