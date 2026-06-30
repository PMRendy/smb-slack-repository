// SMB Bayaning Puyat — Shared Backend + Slack Proxy
// Solves two problems:
// 1. CORS when posting to Slack directly from the browser (original purpose)
// 2. Shared game state — so the admin and every player see the SAME live
//    game, not their own private browser localStorage copy.
//
// FIX: state file now lives in the OS temp directory (os.tmpdir()) instead
// of __dirname, since some hosting environments mount the project directory
// read-only at runtime, which silently crashes any code that tries to write
// there. The temp directory is reliably writable everywhere.
//
// Note: temp storage (and Render's free-tier disk in general) is ephemeral —
// state may be wiped on redeploy/restart. Fine for a nightly game; just don't
// expect state to survive a server restart mid-game.

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(os.tmpdir(), 'smb-bingo-gamestate.json');

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

function defaultState() {
  return {
    adminPin: '0000',
    webhookUrl: '',
    proxyUrl: '',
    drawIntervalMin: 30,
    players: [],
    game: null,
    updatedAt: Date.now(),
  };
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log('[STATE] No existing state file, starting fresh at', DATA_FILE);
      return defaultState();
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[STATE] Failed to load state, using default:', e.message);
    return defaultState();
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[STATE] Failed to write state file:', e.message);
  }
}

let DB;
try {
  DB = loadState();
  console.log('[STATE] Initial state loaded successfully. Players:', (DB.players || []).length);
} catch (e) {
  console.error('[STATE] CRITICAL: failed to initialize state, using in-memory default:', e);
  DB = defaultState();
}

app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'smb-bingo-backend', time: new Date().toISOString() });
});

app.get('/state', (req, res) => {
  res.status(200).json(DB);
});

app.post('/state', (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Invalid state payload' });
    }
    incoming.updatedAt = Date.now();
    DB = incoming;
    saveState(DB);
    res.status(200).json({ ok: true, updatedAt: DB.updatedAt });
  } catch (e) {
    console.error('[STATE] Failed to save state:', e);
    res.status(500).json({ error: 'Failed to save state', detail: String(e.message || e) });
  }
});

app.post('/state/patch', (req, res) => {
  try {
    const patch = req.body;
    if (!patch || typeof patch !== 'object') {
      return res.status(400).json({ error: 'Invalid patch payload' });
    }
    DB = deepMerge(DB, patch);
    DB.updatedAt = Date.now();
    saveState(DB);
    res.status(200).json({ ok: true, state: DB });
  } catch (e) {
    console.error('[STATE] Failed to patch state:', e);
    res.status(500).json({ error: 'Failed to patch state', detail: String(e.message || e) });
  }
});

function deepMerge(target, source) {
  if (Array.isArray(source)) return source;
  if (typeof source !== 'object' || source === null) return source;
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key]) &&
        typeof target?.[key] === 'object' && target?.[key] !== null) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

app.post('/state/reset', (req, res) => {
  DB = defaultState();
  saveState(DB);
  res.status(200).json({ ok: true });
});

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
    console.error('[SLACK] Proxy error:', err);
    return res.status(500).json({ error: 'Proxy failed to reach Slack', detail: String(err.message || err) });
  }
});

app.use((req, res) => {
  console.log(`[404] No route matched: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Not found', method: req.method, url: req.url });
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
});

app.listen(PORT, () => {
  console.log(`SMB BINGO backend (shared state + Slack proxy) listening on port ${PORT}`);
});
