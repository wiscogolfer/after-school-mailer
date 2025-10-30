import express from "express";
import cors from "cors";
import "dotenv/config";
import { Resend } from "resend";
import admin from "firebase-admin";

if (!admin.apps.length) {
  try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  } catch (e) { console.error("Firebase init failed:", e.message); }
}

const app = express();
app.use(express.json());
const allowed = new Set(["https://classesapp.state48arts.org","http://localhost:5173","http://localhost:3000","http://127.0.0.1:5173","http://127.0.0.1:3000"]);
app.use(cors({ origin(origin, cb){ if(!origin) return cb(null,true); if(allowed.has(origin)) return cb(null,true); cb(new Error("Not allowed by CORS")); }}));

app.get("/", (_req,res)=>res.json({ok:true}));

const resend = new Resend(process.env.RESEND_API_KEY);
app.post("/send-email", async (req,res)=>{
  try{
    const { to, bcc, subject, text, replyTo } = req.body || {};
    if ((!to && (!bcc || !bcc.length)) || !subject || !text) return res.status(400).json({ error: "Missing to/bcc, subject, or text" });
    const fromAddress = process.env.FROM_EMAIL || "contact@state48theatre.com";
    const payload = { from: fromAddress, to: to ? [to] : ["undisclosed-recipients:;"], subject, text };
    if (Array.isArray(bcc) && bcc.length) payload.bcc = bcc;
    if (replyTo?.email) payload.reply_to = replyTo.name ? `${replyTo.name} <${replyTo.email}>` : replyTo.email;
    const result = await resend.emails.send(payload);
    if (result.error) return res.status(500).json({ error: String(result.error) });
    res.json({ ok:true, id: result.id || null });
  }catch(err){ res.status(500).json({ error: err.message }); }
});

const verifyBearer = async (req)=>{
  const h=req.get("Authorization")||""; const t=h.startsWith("Bearer ")?h.slice(7):null;
  if(!t) throw new Error("Missing bearer token");
  return await admin.auth().verifyIdToken(t);
};
const requireAdmin = async (req)=>{ const dec=await verifyBearer(req); if(!dec.admin) throw new Error("Admin privileges required"); return dec; };

app.get("/list-users", async (req,res)=>{
  try{
    await requireAdmin(req);
    const users=[]; let token=undefined;
    do{ const page=await admin.auth().listUsers(1000, token); page.users.forEach(u=>users.push({uid:u.uid,email:u.email||null,displayName:u.displayName||null,isAdmin:!!(u.customClaims&&u.customClaims.admin)})); token=page.pageToken; }while(token);
    res.json({ users });
  }catch(err){ res.status(401).json({ error: err.message }); }
});

app.post("/create-user", async (req,res)=>{
  try{
    await requireAdmin(req);
    const { name, email, password } = req.body || {};
    if(!name||!email||!password) return res.status(400).json({ error: "name, email, password required" });
    const user=await admin.auth().createUser({ email, password, displayName: name });
    res.json({ ok:true, uid:user.uid, email:user.email, displayName:user.displayName });
  }catch(err){ res.status(400).json({ error: err.message }); }
});

app.post("/delete-user", async (req,res)=>{
  try{
    await requireAdmin(req);
    const { uid } = req.body || {};
    if(!uid) return res.status(400).json({ error: "uid required" });
    await admin.auth().deleteUser(uid);
    res.json({ ok:true });
  }catch(err){ res.status(400).json({ error: err.message }); }
});

app.post("/set-admin", async (req,res)=>{
  try{
    await requireAdmin(req);
    const { uidToMakeAdmin } = req.body || {};
    if(!uidToMakeAdmin) return res.status(400).json({ error: "uidToMakeAdmin required" });
    await admin.auth().setCustomUserClaims(uidToMakeAdmin, { admin: true });
    res.json({ ok:true });
  }catch(err){ res.status(400).json({ error: err.message }); }
});

app.post("/update-user-name", async (req,res)=>{
  try{
    await requireAdmin(req);
    const { uid, newName } = req.body || {};
    if(!uid||!newName) return res.status(400).json({ error: "uid and newName required" });
    await admin.auth().updateUser(uid, { displayName: newName });
    res.json({ ok:true });
  }catch(err){ res.status(400).json({ error: err.message }); }
});

const port = process.env.PORT || 8080;
app.listen(port, ()=>console.log("Listening on", port));
