// DIAGNOSTIC VERSION — temporary, for troubleshooting the /slack 404 issue.
// This adds logging to every incoming request so we can see exactly what
// Render is receiving, plus a few extra test routes to isolate the problem.

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Log EVERY incoming request so we can see it in the Render logs
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'smb-slack-proxy-DIAGNOSTIC', time: new Date().toISOString() });
});

// Simple test route with no logic — just to confirm POST routing works at all
app.post('/ping', (req, res) => {
  console.log('[PING] Received a POST to /ping');
  res.status(200).json({ pong: true, receivedBody: req.body });
});

// The real route
app.post('/slack', async (req, res) => {
  console.log('[SLACK] Received a POST to /slack');
  try {
    const { webhookUrl, payload } = req.body || {};

    if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('https://hooks.slack.com/services/')) {
      console.log('[SLACK] Rejected: invalid webhookUrl', webhookUrl);
      return res.status(400).json({ error: 'Invalid or missing webhookUrl. Must be a valid Slack webhook URL.' });
    }
    if (!payload || typeof payload !== 'object') {
      console.log('[SLACK] Rejected: missing payload');
      return res.status(400).json({ error: 'Missing payload object.' });
    }

    const slackResp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await slackResp.text();
    console.log('[SLACK] Slack responded with status', slackResp.status, text);

    if (!slackResp.ok) {
      return res.status(slackResp.status).json({ error: 'Slack rejected the request', detail: text });
    }

    return res.status(200).json({ ok: true, slackResponse: text });
  } catch (err) {
    console.error('[SLACK] Proxy error:', err);
    return res.status(500).json({ error: 'Proxy failed to reach Slack', detail: String(err.message || err) });
  }
});

// Catch-all — logs anything that doesn't match a route above, including the real /slack
// if something upstream is somehow not matching it correctly.
app.use((req, res) => {
  console.log(`[404 CATCH-ALL] No route matched: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Not found (diagnostic catch-all)', method: req.method, url: req.url });
});

app.listen(PORT, () => {
  console.log(`SMB Slack proxy (DIAGNOSTIC) listening on port ${PORT}`);
});
