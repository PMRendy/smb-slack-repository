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

// ─── MARCUS GANZO POINTS INTEGRATION ──────────────────────────────────────────
// Server-to-server only — lets a player spend Marcus points to buy an extra card.
// Set these two env vars on this Render service to enable "Buy an Extra Card":
//   MARCUS_BASE_URL = https://<your-marcus-render-url>
//   MARCUS_SECRET   = same value as BINGO_INTEGRATION_SECRET on the Marcus service
const MARCUS_BASE_URL = (process.env.MARCUS_BASE_URL || '').trim().replace(/\/+$/, '');
const MARCUS_SECRET   = process.env.MARCUS_SECRET || '';
const POINTS_PER_CARD = 5;
const MAX_PURCHASED_CARDS_PER_SHIFT = 3;

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
// IMPORTANT: null incoming means intentional reset — honour it.
function mergeGameState(existing, incoming) {
  // null/undefined incoming on /state/merge = no game field sent = keep existing
  // But on POST /state (full replace), incoming=null IS intentional — handled there
  if (incoming === undefined) return existing;
  if (incoming === null) return null; // intentional reset — clear the game
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

  // rsvpPlayerIds / skipPlayerIds: union, never drop someone's RSVP or skip.
  // FIX: these two were previously NOT special-cased above, so they fell under the plain
  // `{...existing, ...incoming}` spread — meaning whichever browser's save landed last
  // simply overwrote the whole list. If two players tapped RSVP (or one RSVP'd and another
  // skipped) within the same few seconds, one of them could silently vanish from the lobby
  // list. Union-merging fixes that the same way drawnNumbers/playerMarks already were fixed.
  const eRsvp = existing.rsvpPlayerIds || [];
  const iRsvp = incoming.rsvpPlayerIds || [];
  const eSkip = existing.skipPlayerIds || [];
  const iSkip = incoming.skipPlayerIds || [];
  // A player who appears in the freshest side's skip list is treated as having reversed
  // their earlier RSVP (and vice versa) — whichever list they show up in on `incoming`
  // (the just-submitted update) wins for that specific player.
  const rsvpSet = new Set([...eRsvp, ...iRsvp]);
  const skipSet = new Set([...eSkip, ...iSkip]);
  iSkip.forEach(pid => rsvpSet.delete(pid)); // just switched to "not playing"
  iRsvp.forEach(pid => skipSet.delete(pid)); // just switched to "playing"
  merged.rsvpPlayerIds = [...rsvpSet];
  merged.skipPlayerIds = [...skipSet];

  // cardPurchases: {playerId: count} — grows-only per player (never decreases), same
  // race-safety pattern as everything else here, since two purchases could land close together.
  const eBuys = existing.cardPurchases || {};
  const iBuys = incoming.cardPurchases || {};
  const allBuyerIds = new Set([...Object.keys(eBuys), ...Object.keys(iBuys)]);
  const mergedBuys = {};
  allBuyerIds.forEach(pid => { mergedBuys[pid] = Math.max(eBuys[pid] || 0, iBuys[pid] || 0); });
  merged.cardPurchases = mergedBuys;

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

// POST /state — replace state wholesale (admin full writes: reset, end game, start game)
// Smart-merges the game field ONLY when both sides have a game with the same ID.
// If incoming.game is null, it means intentional reset — allow it through.
app.post('/state', (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    let mergedGame;
    if (incoming.game === null || incoming.game === undefined) {
      // Intentional reset — wipe the game
      mergedGame = null;
    } else {
      // Smart-merge only when both sides have a game with the same ID
      mergedGame = mergeGameState(DB.game, incoming.game);
    }

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
// Exception: if incoming.game is explicitly null, treat as reset.
app.post('/state/merge', (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    let mergedGame;
    if ('game' in incoming && incoming.game === null) {
      // Explicit null = intentional reset — clear the game on server too
      mergedGame = null;
      console.log('[STATE/MERGE] Explicit game reset received');
    } else if (!('game' in incoming)) {
      // game field not sent at all — keep existing
      mergedGame = DB.game;
    } else {
      // Merge with existing
      mergedGame = mergeGameState(DB.game, incoming.game);
    }

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

// ─── MARCUS POINTS → BUY EXTRA CARD ────────────────────────────────────────────
// GET /points-balance?slackUserId=... — proxies Marcus's balance endpoint so the
// frontend never needs Marcus's URL/secret directly.
app.get('/points-balance', async (req, res) => {
  try {
    if (!MARCUS_BASE_URL || !MARCUS_SECRET) {
      return res.status(503).json({ error: 'Marcus integration not configured on this server' });
    }
    const { slackUserId } = req.query;
    if (!slackUserId) return res.status(400).json({ error: 'slackUserId required' });
    const r = await fetch(`${MARCUS_BASE_URL}/api/points/balance?userId=${encodeURIComponent(slackUserId)}`, {
      headers: { Authorization: `Bearer ${MARCUS_SECRET}` },
    });
    const j = await r.json();
    res.status(r.status).json(j);
  } catch (e) {
    console.error('[POINTS-BALANCE] Error:', e);
    res.status(500).json({ error: String(e.message) });
  }
});

// POST /buy-card { playerId, slackUserId } — enforces the 3-purchases-per-shift cap here
// (server-side, can't be bypassed from the browser), then spends 5 points via Marcus.
app.post('/buy-card', async (req, res) => {
  try {
    if (!MARCUS_BASE_URL || !MARCUS_SECRET) {
      return res.status(503).json({ error: 'Marcus integration not configured on this server' });
    }
    const { playerId, slackUserId } = req.body || {};
    if (!playerId || !slackUserId) return res.status(400).json({ error: 'playerId and slackUserId required' });
    if (!DB.game || !DB.game.active) return res.status(400).json({ error: 'No active game' });

    const purchases = DB.game.cardPurchases || {};
    const already = purchases[playerId] || 0;
    if (already >= MAX_PURCHASED_CARDS_PER_SHIFT) {
      return res.status(400).json({ error: `Max ${MAX_PURCHASED_CARDS_PER_SHIFT} purchased cards per shift reached` });
    }

    const spendResp = await fetch(`${MARCUS_BASE_URL}/api/points/spend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MARCUS_SECRET}` },
      body: JSON.stringify({ userId: slackUserId, amount: POINTS_PER_CARD }),
    });
    const spendResult = await spendResp.json();
    if (!spendResp.ok || !spendResult.success) {
      return res.status(400).json({ error: 'Not enough points or Marcus unavailable', detail: spendResult });
    }

    DB.game.cardPurchases = { ...purchases, [playerId]: already + 1 };
    saveState(DB);
    res.json({ ok: true, newTotal: spendResult.newTotal, purchasesThisShift: already + 1 });
  } catch (e) {
    console.error('[BUY-CARD] Error:', e);
    res.status(500).json({ error: String(e.message) });
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
