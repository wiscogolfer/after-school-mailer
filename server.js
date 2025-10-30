import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Resend } from 'resend';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Allow CORS from your web app (comma-separated list supported)
const allowed = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim())
  : true;
app.use(cors({ origin: allowed }));

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.FROM_ADDRESS || 'noreply@example.com';

app.get('/', (_req, res) => res.send('Resend mailer OK'));

app.post('/send-email', async (req, res) => {
  try {
    const { to, bcc, subject, text, html, replyTo } = req.body || {};

    if (!subject || !(text || html)) {
      return res.status(400).json({ error: 'subject and text/html are required' });
    }
    if (!to && (!bcc || !Array.isArray(bcc) || bcc.length === 0)) {
      return res.status(400).json({ error: 'Provide either \"to\" or non-empty \"bcc\" array' });
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
      console.error('Resend error:', error);
      return res.status(502).json({ error: error.message || 'Resend send failed' });
    }
    return res.json({ id: data?.id || 'ok' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Mailer listening on :${port}`);
});
