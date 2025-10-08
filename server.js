// server.js — Player-centric camera, static course with fixed pipes & finish line.
// Keeps spectators, room browser, countdown, anti-spam flaps, interpolation metadata.

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

const TICK_RATE = 60;
const SNAP_RATE = 20;

const VIEW_W = 1920;            // logical camera size (client renders at this, CSS scales)
const VIEW_H = 1080;

// Physics / gameplay
const GRAVITY = 0.5;
const FLAP_VY = -9.0;
const RUN_SPEED = 4.2;          // world units per tick (player moves right)
const BIRD_RADIUS = 14;
const GROUND_H = 100;           // ground band height

// Pipes & course
const PIPE_GAP = 210;
const PIPE_HALF_W = 40;         // 80px pipes
const PIPE_SPACING = 520;       // distance between successive pipes
const COURSE_MARGIN_X = 600;    // start offset before first pipe
const FINISH_PIPES = 15;        // number of pipes to clear to win
const FINISH_PAD_X = 600;       // distance after last pipe to finish line

// Lobby / round flow
const MIN_PLAYERS = 2;
const COUNTDOWN_SECONDS = 3;
const LOBBY_READY_REQUIRED = true;

// Anti-spam
const MIN_FLAP_INTERVAL_MS = 120;

// Express + WS
const app = express();
app.use(express.static('public'));
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

/**
 * Room state:
 *   state: 'lobby' | 'countdown' | 'playing' | 'gameover'
 *   course: { pipes: [{id,x,top,bottom,seq}], startX, finishX }
 *   players: Map<id, { x,y,vy,name,ready,spectator,lastFlapAt,progress,respawnAt }>
 *   countdownEndsAt, winnerId
 */
const rooms = new Map();

function makeRoom(roomId) {
  rooms.set(roomId, {
    state: 'lobby',
    course: null,
    players: new Map(),
    countdownEndsAt: null,
    winnerId: null
  });
}

function makeCourse() {
  const startX = 0;                                   // global start coordinate
  const firstPipeX = startX + COURSE_MARGIN_X;
  const pipes = [];
  const marginY = 200;
  for (let i = 0; i < FINISH_PIPES; i++) {
    const x = firstPipeX + i * PIPE_SPACING;
    const gapCenter = marginY + Math.random() * (VIEW_H - GROUND_H - marginY * 2);
    const top = gapCenter - PIPE_GAP / 2;
    const bottom = gapCenter + PIPE_GAP / 2;
    pipes.push({ id: uuidv4(), x, top, bottom, seq: i });
  }
  const lastPipeX = pipes[pipes.length - 1].x;
  const finishX = lastPipeX + FINISH_PAD_X;           // static finish line
  return { pipes, startX, finishX };
}

function resetPlayersForRound(room, midRound = false) {
  for (const [, p] of room.players) {
    p.x = room.course.startX + 80;  // small offset into the world
    p.y = VIEW_H / 2;
    p.vy = 0;
    p.progress = 0;
    p.respawnAt = 0;
    if (!midRound) {
      p.ready = false;
      p.spectator = false;          // spectators become eligible next round
    }
  }
}

function resetToLobby(room) {
  room.state = 'lobby';
  room.countdownEndsAt = null;
  room.winnerId = null;
  room.course = null;
  // keep players but clear readiness; spectators return to eligible state
  for (const [, p] of room.players) { p.ready = false; p.spectator = false; }
}

function startCountdown(room) {
  room.state = 'countdown';
  room.countdownEndsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
}

function startPlaying(room) {
  room.state = 'playing';
  room.winnerId = null;
  room.course = makeCourse();
  resetPlayersForRound(room, /*midRound*/ true);
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

function onCrash(room, p) {
  // Respawn THIS player at global start; others continue.
  p.x = room.course.startX + 80;
  p.y = VIEW_H / 2;
  p.vy = 0;
  p.progress = 0;
  p.respawnAt = 0; // could add delay if desired
}

function stepRoom(room) {
  if (room.state === 'lobby' && canStartCountdown(room)) startCountdown(room);
  if (room.state === 'countdown' && Date.now() >= room.countdownEndsAt) startPlaying(room);
  if (room.state !== 'playing') return;

  const groundY = VIEW_H - GROUND_H;

  for (const [id, p] of room.players) {
    if (p.spectator) continue;

    // advance horizontally
    p.x += RUN_SPEED;

    // vertical physics
    p.vy += GRAVITY;
    p.y += p.vy;

    // bounds
    if (p.y < BIRD_RADIUS) { p.y = BIRD_RADIUS; p.vy = 0; }
    if (p.y > groundY - BIRD_RADIUS) {
      onCrash(room, p);
      continue;
    }

    // collisions & progress
    for (const pipe of room.course.pipes) {
      // axis check: if we're overlapping pipe column at our x
      const inX = (pipe.x - PIPE_HALF_W) <= p.x && p.x <= (pipe.x + PIPE_HALF_W);
      if (inX) {
        if (p.y - BIRD_RADIUS < pipe.top || p.y + BIRD_RADIUS > pipe.bottom) {
          onCrash(room, p);
          break;
        }
      }
      // increment progress when passing pipe center
      if (!p._scored) p._scored = new Set();
      if (!p._scored.has(pipe.seq) && p.x > pipe.x + PIPE_HALF_W) {
        p._scored.add(pipe.seq);
        p.progress += 1;
      }
    }

    // finish check
    if (!room.winnerId && p.progress >= FINISH_PIPES && p.x >= room.course.finishX) {
      room.winnerId = id;
      room.state = 'gameover';
      setTimeout(() => resetToLobby(room), 3500);
    }
  }
}

function snapshot(room) {
  const players = [...room.players.entries()].map(([id, p]) => ({
    id, name: p.name ?? 'Player',
    x: p.x, y: p.y, vy: p.vy,
    ready: !!p.ready, spectator: !!p.spectator,
    progress: p.progress || 0
  }));

  const elig = players.filter(p => !p.spectator);
  const readyCount = elig.filter(p => p.ready).length;

  return {
    type: 'state',
    serverTime: Date.now(),
    state: room.state,
    countdownEndsAt: room.countdownEndsAt,
    winnerId: room.winnerId,
    view: { w: VIEW_W, h: VIEW_H, groundH: GROUND_H },
    course: room.course ? {
      startX: room.course.startX,
      finishX: room.course.finishX,
      pipes: room.course.pipes.map(p => ({ id: p.id, x: p.x, top: p.top, bottom: p.bottom, seq: p.seq })),
      finishPipes: FINISH_PIPES,
      pipeHalfW: PIPE_HALF_W
    } : null,
    players,
    meta: {
      players: elig.length,
      spectators: players.length - elig.length,
      readyCount,
      minPlayers: MIN_PLAYERS
    }
  };
}

function joinRoom(ws, roomId, name) {
  if (!rooms.has(roomId)) makeRoom(roomId);
  const room = rooms.get(roomId);
  const id = uuidv4();
  const joiningDuringRound = room.state === 'playing';

  const p = {
    name: (name || 'Player').slice(0, 16),
    x: 0, y: 0, vy: 0,
    ready: false,
    spectator: joiningDuringRound,     // if mid-round, join as spectator
    lastFlapAt: 0,
    progress: 0,
    respawnAt: 0,
    _scored: new Set()
  };
  room.players.set(id, p);

  if (room.state === 'playing' && room.course) {
    // put viewers at start but spectating; camera on client will handle view
    p.x = room.course.startX + 80;
    p.y = VIEW_H / 2;
  } else if (room.course) {
    p.x = room.course.startX + 80;
    p.y = VIEW_H / 2;
  }

  ws._playerId = id;
  ws._roomId = roomId;
  ws.send(JSON.stringify({ type: 'joined', id, roomId }));
  ws.send(JSON.stringify(snapshot(room)));
}

function leaveRoom(ws) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  room.players.delete(ws._playerId);
  if (room.players.size === 0) rooms.delete(ws._roomId);
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
    const p = room.players.get(ws._playerId);
    if (!p) return;

    if (msg.type === 'ready' && room.state === 'lobby' && !p.spectator) {
      p.ready = !!msg.ready;
    }
    if (msg.type === 'flap' && room.state === 'playing' && !p.spectator) {
      const now = Date.now();
      if (now - (p.lastFlapAt || 0) >= MIN_FLAP_INTERVAL_MS) {
        p.vy = FLAP_VY;
        p.lastFlapAt = now;
      }
    }
    if (msg.type === 'restart') {
      resetToLobby(room);
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

// Game & snapshot loops
setInterval(() => { for (const room of rooms.values()) stepRoom(room); }, 1000 / TICK_RATE);

setInterval(() => {
  const bundles = new Map();
  for (const [rid, room] of rooms.entries()) bundles.set(rid, JSON.stringify(snapshot(room)));
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const snap = bundles.get(client._roomId);
    if (snap) client.send(snap);
  }
}, 1000 / SNAP_RATE);

// -------- Room browser REST ----------
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

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
