// SMB Bayaning Puyat — Shared Backend + Slack Proxy v3
// KEY FIX: Server now does smart merging of game state server-side.
// The /state/merge endpoint ensures drawnNumbers, calledSet and playerMarks
// can only grow — they are never replaced with a shorter/empty version.
// This prevents Render free-tier restarts from wiping mid-game state.

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// Write to os.tmpdir() — avoids read-only __dirname on Render free tier.
// State survives as long as the process stays alive.
// On restart, browsers re-seed from their localStorage fallback.
const DATA_FILE = path.join(os.tmpdir(), 'smb-bingo-gamestate.json');

app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
  if (req.method !== 'GET') {
    console.log(`[${req.method}] ${req.url}`);
  }
  next();
});

// ─── STATE HELPERS ────────────────────────────────────────────────────────────

function defaultState() {
  return {
    adminPin: '0000',
    webhookUrl: '',
    proxyUrl: '',
    drawIntervalMin: 10,
    players: [],
    game: null,
    gameHistory: [],
    updatedAt: Date.now(),
    _serverStartedAt: Date.now(),
  };
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultState();
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    console.log('[STATE] Loaded from disk. updatedAt:', parsed.updatedAt, 'players:', (parsed.players||[]).length);
    return parsed;
  } catch (e) {
    console.error('[STATE] Load failed, starting fresh:', e.message);
    return defaultState();
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  } catch (e) {
    console.error('[STATE] Write failed (non-fatal):', e.message);
  }
}

// Smart game merge — called both by /state/merge and internally.
// Ensures drawnNumbers, calledSet, and playerMarks can only grow, never shrink.
function mergeGameState(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return incoming;

  // If game IDs differ, incoming is a new game — replace fully
  if (!existing.id || !incoming.id || existing.id !== incoming.id) {
    return incoming;
  }

  const merged = { ...existing, ...incoming };

  // drawnNumbers: keep whichever array is longer
  const eDrawn = existing.drawnNumbers || [];
  const iDrawn = incoming.drawnNumbers || [];
  merged.drawnNumbers = iDrawn.length >= eDrawn.length ? iDrawn : eDrawn;

  // calledSet: keep whichever array is longer
  const eCalled = existing.calledSet || [];
  const iCalled = incoming.calledSet || [];
  merged.calledSet = iCalled.length >= eCalled.length ? iCalled : eCalled;

  // playerMarks: deep union — never drop any player's marks
  const eMarks = existing.playerMarks || {};
  const iMarks = incoming.playerMarks || {};
  const allPids = new Set([...Object.keys(eMarks), ...Object.keys(iMarks)]);
  const mergedMarks = {};
  allPids.forEach(pid => {
    const eCards = eMarks[pid] || {};
    const iCards = iMarks[pid] || {};
    const allCards = new Set([...Object.keys(eCards), ...Object.keys(iCards)]);
    mergedMarks[pid] = {};
    allCards.forEach(ci => {
      const eCells = eCards[ci] || {};
      const iCells = iCards[ci] || {};
      // Union: if either side has a mark in a cell, keep it
      mergedMarks[pid][ci] = { ...eCells, ...iCells };
    });
  });
  merged.playerMarks = mergedMarks;

  // playerCards: keep whichever has more players' cards
  const eCards = existing.playerCards || {};
  const iCards = incoming.playerCards || {};
  merged.playerCards = Object.keys(iCards).length >= Object.keys(eCards).length ? iCards : eCards;

  return merged;
}

let DB = loadState();

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'smb-bingo-backend',
    time: new Date().toISOString(),
    serverStartedAt: DB._serverStartedAt,
    gameActive: !!(DB.game && DB.game.active),
    drawnCount: DB.game ? (DB.game.drawnNumbers || []).length : 0,
  });
});

// GET full state
app.get('/state', (req, res) => {
  res.json(DB);
});

// POST /state — replace state wholesale (admin full writes)
// Still does a server-side smart merge on the game field to protect in-flight data
app.post('/state', (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Smart-merge the game field even on full state writes
    const mergedGame = mergeGameState(DB.game, incoming.game);
    DB = { ...incoming, game: mergedGame, updatedAt: Date.now() };
    saveState(DB);
    res.json({ ok: true, updatedAt: DB.updatedAt });
  } catch (e) {
    console.error('[STATE] POST failed:', e);
    res.status(500).json({ error: String(e.message) });
  }
});

// POST /state/merge — CLIENT-SIDE smart merge endpoint
// Use this for all game-progress writes (draws, marks, RSVPs).
// Server merges with its own current state so nothing is ever lost.
app.post('/state/merge', (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Merge game state smartly
    const mergedGame = mergeGameState(DB.game, incoming.game);

    // For non-game fields, incoming wins (settings, roster, etc.)
    DB = { ...DB, ...incoming, game: mergedGame, updatedAt: Date.now() };
    saveState(DB);
    res.json({ ok: true, updatedAt: DB.updatedAt, game: DB.game });
  } catch (e) {
    console.error('[STATE/MERGE] Failed:', e);
    res.status(500).json({ error: String(e.message) });
  }
});

// POST /state/reset
app.post('/state/reset', (req, res) => {
  DB = defaultState();
  saveState(DB);
  res.json({ ok: true });
});

// POST /slack proxy
app.post('/slack', async (req, res) => {
  try {
    const { webhookUrl, payload } = req.body || {};
    if (!webhookUrl || !webhookUrl.startsWith('https://hooks.slack.com/services/')) {
      return res.status(400).json({ error: 'Invalid webhookUrl' });
    }
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Missing payload' });
    }
    const slackResp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await slackResp.text();
    if (!slackResp.ok) {
      return res.status(slackResp.status).json({ error: 'Slack rejected', detail: text });
    }
    res.json({ ok: true, slackResponse: text });
  } catch (err) {
    console.error('[SLACK] Error:', err);
    res.status(500).json({ error: String(err.message) });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', url: req.url });
});

// Keep alive — prevent crashes from killing the process
process.on('uncaughtException',  e => console.error('[FATAL] uncaughtException:', e));
process.on('unhandledRejection', e => console.error('[FATAL] unhandledRejection:', e));

app.listen(PORT, () => {
  console.log(`SMB BINGO backend v3 listening on port ${PORT}`);
  console.log(`State file: ${DATA_FILE}`);
});
