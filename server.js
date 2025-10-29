import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import * as admin from "firebase-admin";

dotenv.config();

/**
 * ENV you must set locally or on your host (e.g., Render):
 * - PORT=8080
 * - ALLOWED_ORIGIN=https://after-school-mailer.onrender.com
 * - ORGANIZATION_ID=State-48-Dance
 * - STRIPE_API_KEY_HALLE=sk_live_...
 * - STRIPE_API_KEY_STATE48=sk_live_...
 * - SMTP_HOST=
 * - SMTP_PORT=587
 * - SMTP_USER=
 * - SMTP_PASS=
 * 
 * Firebase Admin credential:
 * - GOOGLE_APPLICATION_CREDENTIALS points to a service account json
 *   OR you can set FIREBASE_SERVICE_ACCOUNT (base64 json) and decode it here.
 */

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN] : true,
  credentials: true
}));

// ---- Firebase Admin init ----
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8"));
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    } else {
      admin.initializeApp(); // Uses GOOGLE_APPLICATION_CREDENTIALS
    }
  } catch (e) {
    console.error("Firebase admin init error:", e);
    process.exit(1);
  }
}
const db = admin.firestore();

// ---- Helpers ----
const ORGANIZATION_ID = process.env.ORGANIZATION_ID || "State-48-Dance";

const accountToStripe = (accountIdentifier) => {
  if (accountIdentifier === "halle_dance") {
    if (!process.env.STRIPE_API_KEY_HALLE) throw new Error("Missing STRIPE_API_KEY_HALLE");
    return new Stripe(process.env.STRIPE_API_KEY_HALLE);
  }
  if (accountIdentifier === "state48arts.org") {
    if (!process.env.STRIPE_API_KEY_STATE48) throw new Error("Missing STRIPE_API_KEY_STATE48");
    return new Stripe(process.env.STRIPE_API_KEY_STATE48);
  }
  throw new Error("Invalid accountIdentifier");
};

const verifyFirebaseToken = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing bearer token" });
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (e) {
    console.error("verifyFirebaseToken error:", e);
    return res.status(401).json({ error: "Invalid token" });
  }
};

// ---- Mailer (nodemailer) ----
import nodemailer from "nodemailer";
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  } : undefined
});

// ---- Routes ----
app.get("/health", (_req, res) => res.json({ ok: true }));

// Send email
app.post("/send-email", verifyFirebaseToken, async (req, res) => {
  try {
    const { to, bcc, replyTo, subject, text } = req.body || {};
    if (!to && (!Array.isArray(bcc) || bcc.length === 0)) {
      return res.status(400).json({ error: "Provide at least 'to' or 'bcc'" });
    }
    const options = {
      from: replyTo?.email || process.env.SMTP_USER,
      to: to || undefined,
      bcc: Array.isArray(bcc) && bcc.length ? bcc : undefined,
      subject: subject || "(no subject)",
      text: text || ""
    };
    if (replyTo?.email) options.replyTo = `"${replyTo?.name || ""}" <${replyTo.email}>`;
    await transporter.sendMail(options);
    res.json({ message: "Email sent" });
  } catch (e) {
    console.error("/send-email error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Helper: fetch student's mapped stripe customer ID for the given account
async function fetchMappedCustomerId(studentId, accountIdentifier) {
  const ref = db.doc(`organizations/${ORGANIZATION_ID}/students/${studentId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Student not found");
  const data = snap.data();
  const cid = data?.stripeInfo?.[accountIdentifier];
  if (!cid) throw new Error("No mapped Stripe customer ID for this account");
  return cid;
}

// Get invoices for a student + account
app.get("/get-student-invoices/:studentId/:accountIdentifier", verifyFirebaseToken, async (req, res) => {
  try {
    const { studentId, accountIdentifier } = req.params;
    const stripe = accountToStripe(accountIdentifier);
    const customer = await fetchMappedCustomerId(studentId, accountIdentifier);
    const invoices = await stripe.invoices.list({ customer, limit: 30 });
    res.json({ invoices: invoices.data });
  } catch (e) {
    console.error("/get-student-invoices error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Get subscriptions for a student + account
app.get("/get-student-subscriptions/:studentId/:accountIdentifier", verifyFirebaseToken, async (req, res) => {
  try {
    const { studentId, accountIdentifier } = req.params;
    const stripe = accountToStripe(accountIdentifier);
    const customer = await fetchMappedCustomerId(studentId, accountIdentifier);
    const subs = await stripe.subscriptions.list({ customer, status: "all", expand: ["data.default_payment_method"] });
    res.json({ subscriptions: subs.data });
  } catch (e) {
    console.error("/get-student-subscriptions error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Create & finalize a one-off invoice
app.post("/create-invoice", verifyFirebaseToken, async (req, res) => {
  try {
    const { studentId, amount, description, accountIdentifier } = req.body || {};
    if (!studentId || !amount || !description || !accountIdentifier) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const stripe = accountToStripe(accountIdentifier);
    const customer = await fetchMappedCustomerId(studentId, accountIdentifier);

    // amount is dollars, convert to cents
    const unit_amount = Math.round(Number(amount) * 100);
    if (!Number.isFinite(unit_amount) || unit_amount <= 0) throw new Error("Invalid amount");

    const ii = await stripe.invoiceItems.create({
      customer,
      currency: "usd",
      unit_amount,
      description
    });
    const invoice = await stripe.invoices.create({ customer, auto_advance: false });
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);

    res.json({ invoice: finalized, item: ii });
  } catch (e) {
    console.error("/create-invoice error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Manually map a stripe customer id to a student for an account
app.post("/map-stripe-customer", verifyFirebaseToken, async (req, res) => {
  try {
    const { studentId, stripeCustomerId, accountIdentifier } = req.body || {};
    if (!studentId || !stripeCustomerId || !accountIdentifier) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const ref = db.doc(`organizations/${ORGANIZATION_ID}/students/${studentId}`);
    await ref.set({ stripeInfo: { [accountIdentifier]: stripeCustomerId } }, { merge: true });
    res.json({ message: "Mapped successfully" });
  } catch (e) {
    console.error("/map-stripe-customer error:", e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));