// SMB Bayaning Puyat — Shared Backend + Slack Proxy
// Solves two problems:
// 1. CORS when posting to Slack directly from the browser (original purpose)
// 2. Shared game state — so the admin and every player see the SAME live
//    game, not their own private browser localStorage copy.
//
// State is stored in a simple JSON file on disk. Render's free tier disk is
// ephemeral (wiped on redeploy/restart), which is fine for a nightly game —
// just don't expect state to survive a server restart mid-game.

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'gamestate.json');

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ─────────────────────────────────────────────────────────────
//  SIMPLE FILE-BACKED STORE
// ─────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultState();
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to load state, using default:', e.message);
    return defaultState();
  }
}

function saveState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

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

// In-memory cache, synced to disk on every write
let DB = loadState();

// ─────────────────────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'smb-bingo-backend', time: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────
//  SHARED GAME STATE — GET (everyone reads this) / POST (write/update)
// ─────────────────────────────────────────────────────────────

// Get the full shared state
app.get('/state', (req, res) => {
  res.status(200).json(DB);
});

// Replace the full shared state (used by admin actions: start game, draw, end game, settings, roster edits)
