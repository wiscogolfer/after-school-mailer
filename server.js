// server.js (ESM)

// Imports
import express from "express";
import cors from "cors";
import "dotenv/config";
import { Resend } from "resend";

// Firebase Admin (MODULAR SDK)
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// ---------- Firebase Admin init ----------
function getServiceAccountFromEnv() {
  // Expect FIREBASE_SERVICE_ACCOUNT_JSON to be a full JSON string
  // with project_id, client_email, private_key, etc.
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (!raw) return null;

  const parsed = JSON.parse(raw);

  // Render often needs newline fix for private_key
  if (parsed.private_key && typeof parsed.private_key === "string") {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }
  return parsed;
}

const svc = getServiceAccountFromEnv();
if (!getApps().length) {
  try {
    if (!svc?.project_id) {
      throw new Error('Service account object must contain a string "project_id" property.');
    }
    initializeApp({
      credential: cert(svc),
      projectId: svc.project_id,
    });
    console.log("Firebase Admin initialized for project:", svc.project_id);
  } catch (e) {
    console.error("Firebase init failed:", e.message);
  }
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS: allow your app origins
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
      if (!origin) return cb(null, true); // allow curl/postman
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
  })
);

// Health
app.get("/", (_req, res) => res.json({ ok: true }));

// ---------- Resend mailer ----------
const resend = new Resend(process.env.RESEND_API_KEY);

app.post("/send-email", async (req, res) => {
  try {
    const { to, bcc, subject, text, replyTo } = req.body || {};

    if ((!to && (!bcc || !bcc.length)) || !subject || !text) {
      return res
        .status(400)
        .json({ error: "Missing to/bcc, subject, or text" });
    }

    const fromAddress = process.env.FROM_EMAIL || "contact@state48theatre.com";

    // Resend requires a valid "to". If we only have BCC, send to a safe address.
    const toList = to ? [to] : [process.env.DEFAULT_TO || fromAddress];

    const payload = {
      from: fromAddress,
      to: toList,
      subject,
      text,
    };

    if (Array.isArray(bcc) && bcc.length) payload.bcc = bcc;

    // Reply-To: "Name <email>" if both present
    if (replyTo?.email) {
      payload.reply_to = replyTo.name
        ? `${replyTo.name} <${replyTo.email}>`
        : replyTo.email;
    }

    const result = await resend.emails.send(payload);

    if (result?.error) {
      return res.status(500).json({ error: String(result.error) });
    }

    return res.json({ ok: true, id: result?.id || null });
  } catch (err) {
    console.error("send-email error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------- Auth helpers ----------
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

// ---------- Admin endpoints ----------
app.get("/list-users", async (req, res) => {
  try {
    await requireAdmin(req);
    const users = [];
    let token = undefined;

    do {
      const page = await getAuth().listUsers(1000, token);
      page.users.forEach((u) =>
        users.push({
          uid: u.uid,
          email: u.email || null,
          displayName: u.displayName || null,
          isAdmin: !!(u.customClaims && u.customClaims.admin),
        })
      );
      token = page.pageToken;
    } while (token);

    res.json({ users });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/create-user", async (req, res) => {
  try {
    await requireAdmin(req);
    const { name, email, password } = req.body || {};
    if (!name || !email || !password)
      return res
        .status(400)
        .json({ error: "name, email, password required" });

    const user = await getAuth().createUser({
      email,
      password,
      displayName: name,
    });
    res.json({
      ok: true,
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/delete-user", async (req, res) => {
  try {
    await requireAdmin(req);
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ error: "uid required" });
    await getAuth().deleteUser(uid);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/set-admin", async (req, res) => {
  try {
    await requireAdmin(req);
    const { uidToMakeAdmin } = req.body || {};
    if (!uidToMakeAdmin)
      return res.status(400).json({ error: "uidToMakeAdmin required" });

    await getAuth().setCustomUserClaims(uidToMakeAdmin, { admin: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/update-user-name", async (req, res) => {
  try {
    await requireAdmin(req);
    const { uid, newName } = req.body || {};
    if (!uid || !newName)
      return res.status(400).json({ error: "uid and newName required" });

    await getAuth().updateUser(uid, { displayName: newName });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Listen ----------
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
