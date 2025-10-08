import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

const TICK_RATE = 60;
const SNAP_RATE = 20;
const WIDTH = 400;
const HEIGHT = 600;
const GRAVITY = 0.5;
const FLAP_VY = -7.5;
const PIPE_SPEED = 2.5;
const PIPE_GAP = 140;
const PIPE_INTERVAL = 1800;
const BIRD_X = 100;
const BIRD_RADIUS = 12;

const app = express();
app.use(express.static('public'));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const rooms = new Map();

function makeRoom(roomId) {
  rooms.set(roomId, {
    players: new Map(),
    pipes: [],
    lastPipeAt: Date.now(),
    running: true
  });
}

function addPipe(room) {
  const gapCenter = 120 + Math.random() * (HEIGHT - 240);
  const top = gapCenter - PIPE_GAP / 2;
  const bottom = gapCenter + PIPE_GAP / 2;
  room.pipes.push({ x: WIDTH + 40, top, bottom, id: uuidv4() });
}

function stepRoom(room, dt) {
  if (Date.now() - room.lastPipeAt > PIPE_INTERVAL) {
    addPipe(room);
    room.lastPipeAt = Date.now();
  }
  for (const p of room.pipes) p.x -= PIPE_SPEED;
  while (room.pipes.length && room.pipes[0].x < -60) room.pipes.shift();

  for (const [id, pl] of room.players.entries()) {
    if (!pl.alive) continue;
    pl.vy += GRAVITY;
    pl.y += pl.vy;
    if (pl.y < BIRD_RADIUS) { pl.y = BIRD_RADIUS; pl.vy = 0; }
    if (pl.y > HEIGHT - BIRD_RADIUS) { pl.y = HEIGHT - BIRD_RADIUS; pl.alive = false; }

    for (const p of room.pipes) {
      const inPipeX = (p.x - 25) < BIRD_X && BIRD_X < (p.x + 25);
      if (inPipeX) {
        if (pl.y - BIRD_RADIUS < p.top || pl.y + BIRD_RADIUS > p.bottom) {
          pl.alive = false;
          break;
        }
      }
      if (!p.scored) {
        if (p.x + 25 < BIRD_X) {
          p.scored = true;
          if (pl.alive) pl.score += 1;
        }
      }
    }
  }
}

function snapshot(room) {
  return {
    type: 'state',
    w: WIDTH,
    h: HEIGHT,
    pipes: room.pipes.map(p => ({ x: p.x, top: p.top, bottom: p.bottom, id: p.id })),
    players: [...room.players.entries()].map(([id, pl]) => ({
      id, y: pl.y, alive: pl.alive, score: pl.score, name: pl.name ?? 'Player'
    })),
    constants: { BIRD_X, BIRD_RADIUS }
  };
}

function joinRoom(ws, roomId, name) {
  if (!rooms.has(roomId)) makeRoom(roomId);
  const room = rooms.get(roomId);
  const id = uuidv4();
  room.players.set(id, { y: HEIGHT / 2, vy: 0, alive: true, score: 0, name: name?.slice(0, 16) || 'Player' });
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
      const roomId = (msg.roomId || 'lobby').toString().slice(0, 24);
      const name = (msg.name || '').toString();
      joinRoom(ws, roomId, name);
      return;
    }

    const room = rooms.get(ws._roomId);
    if (!room) return;

    if (msg.type === 'flap') {
      const pl = room.players.get(ws._playerId);
      if (!pl || !pl.alive) return;
      pl.vy = FLAP_VY;
    }

    if (msg.type === 'restart') {
      const pl = room.players.get(ws._playerId);
      if (!pl) return;
      pl.y = HEIGHT / 2;
      pl.vy = 0;
      pl.alive = true;
      pl.score = 0;
    }
  });

  ws.on('close', () => { leaveRoom(ws); });
});

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - last) / 1000;
  last = now;
  for (const room of rooms.values()) stepRoom(room, dt);
}, 1000 / TICK_RATE);

setInterval(() => {
  for (const [roomId, room] of rooms.entries()) {
    const snap = JSON.stringify(snapshot(room));
    for (const client of wss.clients) {
      if (client.readyState === 1 && client._roomId === roomId) {
        client.send(snap);
      }
    }
  }
}, 1000 / SNAP_RATE);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});