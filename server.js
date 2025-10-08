// server.js — Multiplayer Flappy Race with per-player camera, respawns, and static finish line
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.static('public'));
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// === GAME CONSTANTS ===
const VIEW_W = 1920;
const VIEW_H = 1080;
const GROUND_H = 100;
const GRAVITY = 0.5;
const FLAP_VY = -9.0;
const RUN_SPEED = 4.0;
const PIPE_GAP = 220;
const PIPE_SPACING = 520;
const PIPE_HALF_W = 40;
const FINISH_PIPES = 15;
const FINISH_PAD_X = 600;
const COURSE_MARGIN_X = 600;
const MIN_FLAP_INTERVAL_MS = 120;
const MIN_PLAYERS = 2;
const COUNTDOWN_SECONDS = 3;
const TICK_RATE = 60;
const SNAP_RATE = 20;

// === ROOM STATE ===
const rooms = new Map();

function makeCourse() {
  const pipes = [];
  const marginY = 180;
  const firstX = COURSE_MARGIN_X;
  for (let i = 0; i < FINISH_PIPES; i++) {
    const x = firstX + i * PIPE_SPACING;
    const gapCenter = marginY + Math.random() * (VIEW_H - GROUND_H - marginY * 2);
    const top = gapCenter - PIPE_GAP / 2;
    const bottom = gapCenter + PIPE_GAP / 2;
    pipes.push({ id: uuidv4(), x, top, bottom, seq: i });
  }
  const finishX = pipes[pipes.length - 1].x + FINISH_PAD_X;
  return { pipes, finishX, pipeHalfW: PIPE_HALF_W, finishPipes: FINISH_PIPES };
}

function makeRoom(id) {
  rooms.set(id, {
    state: 'lobby',
    players: new Map(),
    course: null,
    countdownEndsAt: null,
    winnerId: null
  });
}

function resetToLobby(room) {
  room.state = 'lobby';
  room.course = null;
  room.winnerId = null;
  room.countdownEndsAt = null;
  for (const [, p] of room.players) {
    p.ready = false;
    p.spectator = false;
    p.progress = 0;
  }
}

function startCountdown(room) {
  room.state = 'countdown';
  room.countdownEndsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
}

function startPlaying(room) {
  room.course = makeCourse();
  room.state = 'playing';
  room.winnerId = null;
  room.countdownEndsAt = null;
  for (const [, p] of room.players) {
    p.x = 80;
    p.y = VIEW_H / 2;
    p.vy = 0;
    p.progress = 0;
    p._scored = new Set();
    p.spectator = p.spectator; // preserve spectator flag
  }
}

function canStart(room) {
  const elig = [...room.players.values()].filter(p => !p.spectator);
  if (elig.length < MIN_PLAYERS) return false;
  return elig.every(p => p.ready);
}

function onCrash(room, p) {
  if (!room.course) return;
  p.x = 80;
  p.y = VIEW_H / 2;
  p.vy = 0;
  p.progress = 0;
  p._scored = new Set();
}

function stepRoom(room) {
  if (room.state === 'lobby' && canStart(room)) startCountdown(room);
  if (room.state === 'countdown' && Date.now() >= room.countdownEndsAt) startPlaying(room);
  if (room.state !== 'playing') return;

  const groundY = VIEW_H - GROUND_H;

  for (const [id, p] of room.players) {
    if (p.spectator) continue;
    p.x += RUN_SPEED;
    p.vy += GRAVITY;
    p.y += p.vy;

    if (p.y < 0) { p.y = 0; p.vy = 0; }
    if (p.y > groundY) { onCrash(room, p); continue; }

    // Collision + scoring
    for (const pipe of room.course.pipes) {
      const inX = Math.abs(pipe.x - p.x) < PIPE_HALF_W;
      if (inX && (p.y < pipe.top || p.y > pipe.bottom)) {
        onCrash(room, p);
        break;
      }
      if (!p._scored.has(pipe.seq) && p.x > pipe.x + PIPE_HALF_W) {
        p._scored.add(pipe.seq);
        p.progress++;
      }
    }

    if (!room.winnerId && p.progress >= FINISH_PIPES && p.x >= room.course.finishX) {
      room.winnerId = id;
      room.state = 'gameover';
      const originalRoomState = room.state; // Capture current state
      setTimeout(() => {
        // Check if room still exists and is still in gameover state
        if (rooms.has(room) && room.state === 'gameover') {
          resetToLobby(room);
        }
      }, 3500);
      break; // Important: break to avoid multiple winners in same tick
    }
  }
}

function snapshot(room) {
  const players = [...room.players.entries()].map(([id, p]) => {
    // Omit internal _scored property from snapshot
    const { _scored, ...playerData } = p;
    return { id, ...playerData };
  });

  return {
    type: 'state',
    serverTime: Date.now(),
    state: room.state,
    countdownEndsAt: room.countdownEndsAt,
    winnerId: room.winnerId,
    course: room.course,
    view: { w: VIEW_W, h: VIEW_H, groundH: GROUND_H },
    players
  };
}

function joinRoom(ws, roomId, name) {
  if (!rooms.has(roomId)) makeRoom(roomId);
  const room = rooms.get(roomId);
  const joiningDuringRound = room.state === 'playing';
  const id = uuidv4();
  room.players.set(id, {
    name: (name || 'Player').slice(0, 16), // Fixed: handle undefined name
    x: 80, y: VIEW_H / 2, vy: 0,
    ready: false,
    spectator: joiningDuringRound,
    lastFlapAt: 0,
    progress: 0,
    _scored: new Set()
  });
  ws._roomId = roomId;
  ws._playerId = id;
  
  // Fixed: Added error handling for message sending
  try {
    ws.send(JSON.stringify({ type: 'joined', id, roomId }));
    ws.send(JSON.stringify(snapshot(room)));
  } catch (error) {
    console.error('Error sending message to client:', error);
  }
}

function leaveRoom(ws) {
  const roomId = ws._roomId;
  if (!roomId || !rooms.has(roomId)) return;
  
  const room = rooms.get(roomId);
  const playerId = ws._playerId;
  
  if (playerId && room.players.has(playerId)) {
    room.players.delete(playerId);
  }
  
  if (room.players.size === 0) {
    rooms.delete(roomId);
  }
}

// === WebSocket Handling ===
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { 
      msg = JSON.parse(raw.toString());
    } catch (error) { 
      // Fixed: Send error response back to client
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message' }));
      } catch (sendError) {
        console.error('Error sending error message:', sendError);
      }
      return; 
    }
    
    if (msg.type === 'join') {
      // Fixed: Added input validation
      if (!msg.name || typeof msg.name !== 'string') {
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid player name' }));
        } catch (sendError) {
          console.error('Error sending error message:', sendError);
        }
        return;
      }
      return joinRoom(ws, msg.roomId || 'lobby', msg.name);
    }

    const room = rooms.get(ws._roomId);
    if (!room) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in a room' }));
      } catch (sendError) {
        console.error('Error sending error message:', sendError);
      }
      return;
    }
    
    const p = room.players.get(ws._playerId);
    if (!p) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Player not found' }));
      } catch (sendError) {
        console.error('Error sending error message:', sendError);
      }
      return;
    }

    if (msg.type === 'ready' && room.state === 'lobby') p.ready = true;
    if (msg.type === 'flap' && room.state === 'playing' && !p.spectator) {
      const now = Date.now();
      if (now - p.lastFlapAt >= MIN_FLAP_INTERVAL_MS) {
        p.vy = FLAP_VY;
        p.lastFlapAt = now;
      }
    }
    if (msg.type === 'restart' && room.state === 'gameover') {
      // Only allow restart from gameover state, and only if enough players
      if (canStart(room)) {
        startCountdown(room);
      }
    }
  
  ws.on('close', () => leaveRoom(ws));
  
  // Fixed: Added error event handler
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    leaveRoom(ws);
  });
});

// === GAME LOOP ===
setInterval(() => {
  for (const room of rooms.values()) stepRoom(room);
}, 1000 / TICK_RATE);

setInterval(() => {
  const payloads = new Map();
  for (const [id, room] of rooms.entries()) {
    try {
      payloads.set(id, JSON.stringify(snapshot(room)));
    } catch (error) {
      console.error('Error serializing snapshot for room', id, error);
    }
  }
  
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const snap = payloads.get(client._roomId);
    if (snap) {
      try {
        client.send(snap);
      } catch (error) {
        console.error('Error sending snapshot to client:', error);
        // Don't leaveRoom here as it might be a temporary issue
      }
    }
  }
}, 1000 / SNAP_RATE);

// === ROOM BROWSER REST ===
app.get('/rooms', (_, res) => {
  const data = [...rooms.entries()].map(([id, room]) => ({
    id,
    state: room.state,
    players: [...room.players.values()].filter(p => !p.spectator).length,
    spectators: [...room.players.values()].filter(p => p.spectator).length,
  }));
  res.json({ rooms: data });
});

// === START ===
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));