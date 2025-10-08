// server.js
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

const TICK_RATE = 60;          // physics tick
const SNAP_RATE = 20;          // network snapshots
const WIDTH = 480;             // logical world size
const HEIGHT = 800;
const GRAVITY = 0.5;
const FLAP_VY = -8.0;
const PIPE_SPEED = 2.6;
const PIPE_GAP = 160;
const PIPE_INTERVAL = 1600;    // ms
const BIRD_X = 120;
const BIRD_RADIUS = 12;

const MIN_PLAYERS = 2;                 // players required to start
const COUNTDOWN_SECONDS = 3;           // 3..2..1..Go!
const LOBBY_READY_REQUIRED = true;     // all players must ready up
const MIN_FLAP_INTERVAL_MS = 120;      // anti-spam (server-side)

const app = express();
app.use(express.static('public'));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

/**
 * Room lifecycle:
 *   state: 'lobby' | 'countdown' | 'playing' | 'gameover'
 *   players: Map<id, { y, vy, alive, score, name, ready, spectator, lastFlapAt }>
 *   pipes: []
 *   lastPipeAt
 *   countdownEndsAt: epoch ms when countdown hits 0
 */
const rooms = new Map();

function makeRoom(roomId) {
  rooms.set(roomId, {
    state: 'lobby',
    players: new Map(),
    pipes: [],
    lastPipeAt: 0,
    countdownEndsAt: null,
  });
}

function resetRound(room) {
  room.state = 'lobby';
  room.pipes.length = 0;
  room.lastPipeAt = 0;
  room.countdownEndsAt = null;
  for (const [, p] of room.players) {
    p.y = HEIGHT / 2;
    p.vy = 0;
    p.alive = true;
    p.score = 0;
    p.ready = false;
    // spectators that joined mid-round become eligible to play next round
    p.spectator = false;
  }
}

function addPipe(room) {
  const margin = 120;
  const gapCenter = margin + Math.random() * (HEIGHT - margin * 2);
  const top = gapCenter - PIPE_GAP / 2;
  const bottom = gapCenter + PIPE_GAP / 2;
  room.pipes.push({ x: WIDTH + 50, top, bottom, id: uuidv4(), scoredIds: new Set() });
}

function anyAlive(room) {
  for (const [, p] of room.players) if (p.alive && !p.spectator) return true;
  return false;
}

function playingEligiblePlayers(room) {
  return [...room.players.values()].filter(p => !p.spectator);
}

function canStartCountdown(room) {
  const candidates = playingEligiblePlayers(room);
  if (candidates.length < MIN_PLAYERS) return false;
  if (!LOBBY_READY_REQUIRED) return true;
  return candidates.every(p => p.ready);
}

function startCountdown(room) {
  room.state = 'countdown';
  room.countdownEndsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
}

function startPlaying(room) {
  room.state = 'playing';
  room.pipes.length = 0;
  room.lastPipeAt = Date.now();
  addPipe(room);
}

function stepRoom(room) {
  // Lobby logic
  if (room.state === 'lobby' && canStartCountdown(room)) {
    startCountdown(room);
  }

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
  while (room.pipes.length && room.pipes[0].x < -80) room.pipes.shift();

  // Update players
  for (const [, pl] of room.players) {
    if (!pl.alive || pl.spectator) continue;
    pl.vy += GRAVITY;
    pl.y += pl.vy;
    if (pl.y < BIRD_RADIUS) { pl.y = BIRD_RADIUS; pl.vy = 0; }
    if (pl.y > HEIGHT - BIRD_RADIUS) { pl.y = HEIGHT - BIRD_RADIUS; pl.alive = false; }

    // Collisions & scoring
    for (const p of room.pipes) {
      const inPipeX = (p.x - 30) < BIRD_X && BIRD_X < (p.x + 30);
      if (inPipeX) {
        if (pl.y - BIRD_RADIUS < p.top || pl.y + BIRD_RADIUS > p.bottom) {
          pl.alive = false;
          break;
        }
      }
      // Score once per player per pipe
      if (p.x + 30 < BIRD_X && !p.scoredIds.has(pl)) {
        p.scoredIds.add(pl);
        if (pl.alive) pl.score += 1;
      }
    }
  }

  // End of round if no eligible players alive
  if (!anyAlive(room)) {
    room.state = 'gameover';
    setTimeout(() => resetRound(room), 3000);
  }
}

function snapshot(room) {
  const players = [...room.players.entries()].map(([id, pl]) => ({
    id, y: pl.y, vy: pl.vy, alive: pl.alive, score: pl.score,
    name: pl.name ?? 'Player', ready: !!pl.ready, spectator: !!pl.spectator
  }));
  const eligible = players.filter(p => !p.spectator);
  const readyCount = eligible.filter(p => p.ready).length;

  return {
    type: 'state',
    serverTime: Date.now(),
    state: room.state,
    countdownEndsAt: room.countdownEndsAt,
    w: WIDTH,
    h: HEIGHT,
    pipes: room.pipes.map(p => ({ x: p.x, top: p.top, bottom: p.bottom, id: p.id })),
    players,
    meta: {
      playerCount: eligible.length,
      spectatorCount: players.length - eligible.length,
      readyCount,
      minPlayers: MIN_PLAYERS
    },
    constants: { BIRD_X, BIRD_RADIUS }
  };
}

function joinRoom(ws, roomId, name) {
  if (!rooms.has(roomId)) makeRoom(roomId);
  const room = rooms.get(roomId);
  const id = uuidv4();
  const joiningDuringRound = room.state === 'playing';

  room.players.set(id, {
    y: HEIGHT / 2, vy: 0, alive: !joiningDuringRound, score: 0,
    name: (name || 'Player').slice(0, 16),
    ready: false,
    spectator: joiningDuringRound,     // <- spectator if join mid-round
    lastFlapAt: 0
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
  if (room.players.size === 0) {
    rooms.delete(roomId);
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Initial join
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
    if (msg.type === 'flap' && room.state === 'playing' && pl.alive && !pl.spectator) {
      const now = Date.now();
      if (now - (pl.lastFlapAt || 0) >= MIN_FLAP_INTERVAL_MS) {
        pl.vy = FLAP_VY;
        pl.lastFlapAt = now; // anti-spam
      }
    }
    if (msg.type === 'restart') {
      resetRound(room);
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

// Loops
setInterval(() => { for (const room of rooms.values()) stepRoom(room); }, 1000 / TICK_RATE);

setInterval(() => {
  const snapStrByRoom = new Map();
  for (const [roomId, room] of rooms.entries()) {
    const snapStr = JSON.stringify(snapshot(room));
    snapStrByRoom.set(roomId, snapStr);
  }
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const rid = client._roomId;
    const snap = snapStrByRoom.get(rid);
    if (snap) client.send(snap);
  }
}, 1000 / SNAP_RATE);

// -------- Room browser (REST) ----------
function roomsList() {
  const list = [];
  for (const [id, room] of rooms.entries()) {
    const players = [...room.players.values()];
    const spectators = players.filter(p => p.spectator).length;
    const eligible = players.length - spectators;
    const ready = players.filter(p => p.ready && !p.spectator).length;
    list.push({
      id,
      state: room.state,
      players: eligible,
      spectators,
      ready,
      minPlayers: MIN_PLAYERS
    });
  }
  // Stable order: active rooms first, then by id
  list.sort((a, b) => (a.state === 'lobby' ? -1 : 1) - (b.state === 'lobby' ? -1 : 1) || a.id.localeCompare(b.id));
  return list;
}

app.get('/rooms', (_req, res) => {
  res.json({ rooms: roomsList() });
});

// ---------------------------------------
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
