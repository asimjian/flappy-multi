// server.js — Race mode: first to FINISH_PIPES wins; crash = respawn + progress reset.
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

const TICK_RATE = 60;          // physics tick
const SNAP_RATE = 20;          // network snapshots
const WIDTH = 1920;            // widescreen logical world
const HEIGHT = 1080;
const GRAVITY = 0.5;
const FLAP_VY = -9.0;
const PIPE_SPEED = 3.8;
const PIPE_GAP = 210;
const PIPE_INTERVAL = 1400;    // ms
const PIPE_HALF_W = 40;        // pipe half width (80px wide)
const BIRD_X = 300;            // bird X for all players (world scrolls)
const BIRD_RADIUS = 14;

const MIN_PLAYERS = 2;                 // players required to start
const COUNTDOWN_SECONDS = 3;           // 3..2..1..Go!
const LOBBY_READY_REQUIRED = true;     // all players must ready up
const MIN_FLAP_INTERVAL_MS = 120;      // anti-spam (server-side)

// --- RACE SETTINGS ---
const FINISH_PIPES = 15;               // "finish line": pass this many pipes from your personal start
const RESPAWN_PENALTY_MS = 0;          // keep 0 for instant respawn; bump if you want delay

const app = express();
app.use(express.static('public'));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

/**
 * Room lifecycle:
 *   state: 'lobby' | 'countdown' | 'playing' | 'gameover'
 *   players: Map<id, { y, vy, name, ready, spectator, lastFlapAt, progress, startSeq, respawnAt }>
 *   pipes: [{ x, top, bottom, id, seq, scoredIds:Set }]
 *   lastPipeAt
 *   countdownEndsAt
 *   nextPipeSeq
 *   winnerId
 */
const rooms = new Map();

function makeRoom(roomId) {
  rooms.set(roomId, {
    state: 'lobby',
    players: new Map(),
    pipes: [],
    lastPipeAt: 0,
    countdownEndsAt: null,
    nextPipeSeq: 0,
    winnerId: null,
  });
}

function resetRound(room) {
  room.state = 'lobby';
  room.pipes.length = 0;
  room.lastPipeAt = 0;
  room.countdownEndsAt = null;
  room.nextPipeSeq = 0;
  room.winnerId = null;
  for (const [, p] of room.players) {
    p.y = HEIGHT / 2; p.vy = 0;
    p.ready = false;
    p.spectator = false;               // spectators become eligible next round
    p.progress = 0;
    p.startSeq = 0;
    p.respawnAt = 0;
  }
}

function addPipe(room) {
  const margin = 200; // avoid extreme top/bottom
  const gapCenter = margin + Math.random() * (HEIGHT - margin * 2);
  const top = gapCenter - PIPE_GAP / 2;
  const bottom = gapCenter + PIPE_GAP / 2;
  room.pipes.push({
    x: WIDTH + PIPE_HALF_W + 80,
    top,
    bottom,
    id: uuidv4(),
    seq: room.nextPipeSeq++,
    scoredIds: new Set()
  });
}

function eligiblePlayers(room) {
  return [...room.players.values()].filter(p => !p.spectator);
}
function canStartCountdown(room) {
  const cand = eligiblePlayers(room);
  if (cand.length < MIN_PLAYERS) return false;
  if (!LOBBY_READY_REQUIRED) return true;
  return cand.every(p => p.ready);
}
function startCountdown(room) {
  room.state = 'countdown';
  room.countdownEndsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
}
function startPlaying(room) {
  room.state = 'playing';
  room.pipes.length = 0;
  room.lastPipeAt = Date.now();
  room.nextPipeSeq = 0;
  addPipe(room);
  for (const [, p] of room.players) {
    p.progress = 0;
    p.startSeq = room.nextPipeSeq; // first pipe after start is seq at this time
    p.respawnAt = 0;
    // keep spectators as spectators
  }
}

function stepRoom(room) {
  // Lobby logic
  if (room.state === 'lobby' && canStartCountdown(room)) startCountdown(room);

  // Countdown -> Playing
  if (room.state === 'countdown') {
    if (Date.now() >= room.countdownEndsAt) startPlaying(room);
  }

  if (room.state !== 'playing') return;

  // Spawn pipes
  if (Date.now() - room.lastPipeAt > PIPE_INTERVAL) {
    addPipe(room);
    room.lastPipeAt = Date.now();
  }

  // Move pipes
  for (const p of room.pipes) p.x -= PIPE_SPEED;
  while (room.pipes.length && room.pipes[0].x < -PIPE_HALF_W - 100) room.pipes.shift();

  // Update players (no elimination; crash => respawn + progress reset)
  const now = Date.now();
  for (const [, pl] of room.players) {
    if (pl.spectator) continue;

    // respawn freeze (optional)
    if (pl.respawnAt && now < pl.respawnAt) continue;

    pl.vy += GRAVITY;
    pl.y += pl.vy;

    if (pl.y < BIRD_RADIUS) { pl.y = BIRD_RADIUS; pl.vy = 0; }
    if (pl.y > HEIGHT - BIRD_RADIUS) {
      // "crash" on ground => respawn
      onCrash(room, pl);
      continue;
    }

    // Pipe collisions & scoring
    for (const p of room.pipes) {
      const inPipeX = (p.x - PIPE_HALF_W) < BIRD_X && BIRD_X < (p.x + PIPE_HALF_W);
      if (inPipeX) {
        if (pl.y - BIRD_RADIUS < p.top || pl.y + BIRD_RADIUS > p.bottom) {
          onCrash(room, pl);
          break;
        }
      }
      // Score once per pipe per player — only for pipes after player's personal start
      if (p.x + PIPE_HALF_W < BIRD_X && !p.scoredIds.has(pl) && p.seq >= pl.startSeq) {
        p.scoredIds.add(pl);
        pl.progress += 1;
        if (pl.progress >= FINISH_PIPES && !room.winnerId) {
          room.winnerId = getPlayerId(room, pl);
          room.state = 'gameover';
          setTimeout(() => resetRound(room), 3500);
        }
      }
    }
  }
}

function onCrash(room, pl) {
  pl.y = HEIGHT / 2;
  pl.vy = 0;
  pl.progress = 0;
  // reset “start line” to NEXT pipes generated after now
  pl.startSeq = room.nextPipeSeq;
  pl.respawnAt = RESPAWN_PENALTY_MS ? Date.now() + RESPAWN_PENALTY_MS : 0;
}

function getPlayerId(room, playerObj) {
  for (const [id, p] of room.players.entries()) if (p === playerObj) return id;
  return null;
}

function snapshot(room) {
  const players = [...room.players.entries()].map(([id, pl]) => ({
    id, y: pl.y, vy: pl.vy, name: pl.name ?? 'Player',
    ready: !!pl.ready, spectator: !!pl.spectator,
    progress: pl.progress
  }));
  const elig = players.filter(p => !p.spectator);
  const readyCount = elig.filter(p => p.ready).length;

  return {
    type: 'state',
    serverTime: Date.now(),
    state: room.state,
    countdownEndsAt: room.countdownEndsAt,
    winnerId: room.winnerId,
    w: WIDTH,
    h: HEIGHT,
    finishPipes: FINISH_PIPES,
    pipes: room.pipes.map(p => ({ x: p.x, top: p.top, bottom: p.bottom, id: p.id, seq: p.seq })),
    players,
    meta: {
      players: elig.length,
      spectators: players.length - elig.length,
      readyCount,
      minPlayers: MIN_PLAYERS
    },
    constants: { BIRD_X, BIRD_RADIUS, PIPE_HALF_W }
  };
}

function joinRoom(ws, roomId, name) {
  if (!rooms.has(roomId)) makeRoom(roomId);
  const room = rooms.get(roomId);
  const id = uuidv4();
  const joiningDuringRound = room.state === 'playing';

  room.players.set(id, {
    y: HEIGHT / 2, vy: 0,
    name: (name || 'Player').slice(0, 16),
    ready: false,
    spectator: joiningDuringRound,     // spectators if mid-round
    lastFlapAt: 0,
    progress: 0,
    startSeq: joiningDuringRound ? room.nextPipeSeq : 0,
    respawnAt: 0
  });
  ws._playerId = id;
  ws._roomId = roomId;
  ws.send(JSON.stringify({ type: 'joined', id, roomId }));
  ws.send(JSON.stringify(snapshot(room)));
}

function leaveRoom(ws) {
  const roomId = ws._roomId;
  const id = ws._playerId;
  if (!roomId || !rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  room.players.delete(id);
  if (room.players.size === 0) rooms.delete(roomId);
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'join') {
      joinRoom(ws, (msg.roomId || 'lobby').toString().slice(0, 24), (msg.name || '').toString());
      return;
    }

    const room = rooms.get(ws._roomId);
    if (!room) return;
    const pl = room.players.get(ws._playerId);
    if (!pl) return;

    if (msg.type === 'ready' && room.state === 'lobby' && !pl.spectator) {
      pl.ready = !!msg.ready;
    }
    if (msg.type === 'flap' && room.state === 'playing' && !pl.spectator) {
      const now = Date.now();
      if (now - (pl.lastFlapAt || 0) >= MIN_FLAP_INTERVAL_MS) {
        // allow flaps even immediately after respawn
        pl.vy = FLAP_VY;
        pl.lastFlapAt = now;
      }
    }
    if (msg.type === 'restart') {
      resetRound(room);
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

// Game & snapshot loops
setInterval(() => { for (const room of rooms.values()) stepRoom(room); }, 1000 / TICK_RATE);

setInterval(() => {
  const byRoom = new Map();
  for (const [roomId, room] of rooms.entries()) {
    byRoom.set(roomId, JSON.stringify(snapshot(room)));
  }
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const snap = byRoom.get(client._roomId);
    if (snap) client.send(snap);
  }
}, 1000 / SNAP_RATE);

// ---- Room browser REST ----
function roomsList() {
  const list = [];
  for (const [id, room] of rooms.entries()) {
    const ps = [...room.players.values()];
    const specs = ps.filter(p => p.spectator).length;
    list.push({
      id,
      state: room.state,
      players: ps.length - specs,
      spectators: specs,
      ready: ps.filter(p => p.ready && !p.spectator).length,
      minPlayers: MIN_PLAYERS
    });
  }
  list.sort((a,b) => (a.state === 'lobby' ? -1 : 1) - (b.state === 'lobby' ? -1 : 1) || a.id.localeCompare(b.id));
  return list;
}
app.get('/rooms', (_req, res) => res.json({ rooms: roomsList() }));

// ---------------------------------------
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
