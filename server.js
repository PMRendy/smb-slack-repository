// SMB Bayaning Puyat — Slack Webhook Proxy
// Solves the browser CORS issue when posting from the BINGO artifact directly to Slack.
// Deploy this as a free Web Service on Render.com.

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from any origin (claude.ai artifacts run in a sandboxed iframe
// with a dynamic origin, so we can't whitelist a single domain reliably).
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Simple health check — Render uses this to confirm the service is alive.
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'smb-slack-proxy', time: new Date().toISOString() });
});

// Main proxy endpoint. The BINGO artifact POSTs here instead of directly to Slack.
// Body: { webhookUrl: "https://hooks.slack.com/services/...", payload: { text, blocks, ... } }
app.post('/slack', async (req, res) => {
  try {
    const { webhookUrl, payload } = req.body || {};

    if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('https://hooks.slack.com/services/')) {
      return res.status(400).json({ error: 'Invalid or missing webhookUrl. Must be a valid Slack webhook URL.' });
    }
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Missing payload object.' });
    }

    const slackResp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await slackResp.text();

    if (!slackResp.ok) {
      return res.status(slackResp.status).json({ error: 'Slack rejected the request', detail: text });
    }

    return res.status(200).json({ ok: true, slackResponse: text });
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Proxy failed to reach Slack', detail: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`SMB Slack proxy listening on port ${PORT}`);
});
