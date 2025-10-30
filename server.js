import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Resend } from 'resend';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- CORS setup that ALLOWS the Authorization header ----
const allowList = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptionsDelegate = (req, cb) => {
  const origin = req.header('Origin');
  const isAllowed = allowList.length === 0 || allowList.includes(origin);
  console.log(`[CORS] Origin: ${origin} -> ${isAllowed ? 'allowed' : 'blocked'}`);
  cb(null, {
    origin: isAllowed,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'], // <-- allow Authorization
    maxAge: 86400
  });
};

// Log requests for visibility
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url} from ${req.header('Origin') || 'no-origin'}`);
  next();
});

// Explicit preflight and global cors with Authorization allowed
app.options('/send-email', cors(corsOptionsDelegate));
app.use(cors(corsOptionsDelegate));

// ---- Resend ----
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.FROM_ADDRESS || 'noreply@example.com';

app.get('/', (_req, res) => res.send('Resend mailer OK'));

app.post('/send-email', cors(corsOptionsDelegate), async (req, res) => {
  try {
    const { to, bcc, subject, text, html, replyTo } = req.body || {};
    console.log('[SEND] Payload summary:', {
      hasTo: !!to,
      bccCount: Array.isArray(bcc) ? bcc.length : 0,
      subject: !!subject,
      textLen: text?.length || 0,
      htmlLen: html?.length || 0,
      replyTo
    });

    if (!subject || !(text || html)) {
      return res.status(400).json({ error: 'subject and text/html are required' });
    }
    if (!to && (!bcc || !Array.isArray(bcc) || bcc.length === 0)) {
      return res.status(400).json({ error: 'Provide either "to" or non-empty "bcc" array' });
    }

    const msg = {
      from: FROM,
      to: to ? [to] : undefined,
      bcc: bcc && bcc.length ? bcc : undefined,
      subject,
      text: text || undefined,
      html: html || undefined,
      reply_to: replyTo?.email
        ? (replyTo.name ? `${replyTo.name} <${replyTo.email}>` : replyTo.email)
        : undefined
    };

    const { data, error } = await resend.emails.send(msg);
    if (error) {
      console.error('[SEND][Resend error]', error);
      return res.status(502).json({ error: error.message || 'Resend send failed' });
    }
    console.log('[SEND] Success:', data);
    return res.json({ id: data?.id || 'ok' });
  } catch (err) {
    console.error('[SEND][Server error]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Mailer listening on :${port}`);
  console.log('Allowed origins:', allowList.length ? allowList : '(any)');
});
