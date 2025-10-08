// client.js
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const scoreEl  = document.getElementById('score');
const roomInput = document.getElementById('room');
const nameInput = document.getElementById('name');
const joinBtn = document.getElementById('joinBtn');
const readyBtn = document.getElementById('readyBtn');
const gameStateEl = document.getElementById('gameState');
const countdownEl = document.getElementById('countdown');
const refreshRoomsBtn = document.getElementById('refreshRooms');
const roomsListEl = document.getElementById('roomsList');

let ws, meId = null;

// Snapshot buffer for interpolation
const buffer = [];
const INTERP_DELAY = 120;     // ms
let serverOffset = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const logicalW = 480, logicalH = 800;
  canvas.width = logicalW * dpr;
  canvas.height = logicalH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resizeCanvas();
addEventListener('resize', resizeCanvas);

// ---- Room browser UI ----
async function loadRooms() {
  try {
    roomsListEl.textContent = 'Loading…';
    const res = await fetch('/rooms', { cache: 'no-store' });
    const data = await res.json();
    const rows = [
      rowHeader(['Room', 'State', 'Players', 'Spectators', 'Ready', '']),
      ...data.rooms.map(r => rowItem(r))
    ];
    roomsListEl.replaceChildren(...rows.flat());
  } catch (e) {
    roomsListEl.textContent = 'Failed to load rooms';
  }
}
function rowHeader(cols) {
  return cols.map(text => {
    const el = document.createElement('div');
    el.className = 'head';
    el.textContent = text;
    return el;
  });
}
function rowItem(r) {
  const name = document.createElement('div'); name.textContent = r.id;
  const state = document.createElement('div'); state.textContent = r.state;
  const players = document.createElement('div'); players.textContent = r.players;
  const specs = document.createElement('div'); specs.textContent = r.spectators;
  const ready = document.createElement('div'); ready.textContent = `${r.ready}/${r.players}`;
  const join = document.createElement('button'); join.className = 'room-join'; join.textContent = 'Join';
  join.onclick = () => { roomInput.value = r.id; connect(r.id, nameInput.value.trim() || 'Player'); };
  // Use display: contents for grid rows
  const wrapper = document.createElement('div'); wrapper.className = 'room-item';
  return [name, state, players, specs, ready, (wrapper.appendChild(join), join)];
}
refreshRoomsBtn.addEventListener('click', loadRooms);
setInterval(loadRooms, 5000);
loadRooms();

// ---- Networking ----
function connect(roomId, name) {
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    statusEl.textContent = `connected (${roomId})`;
    ws.send(JSON.stringify({ type: 'join', roomId, name }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'joined') { meId = msg.id; return; }
    if (msg.type === 'state') {
      const now = Date.now();
      const measuredOffset = msg.serverTime - now;
      serverOffset = serverOffset ? (serverOffset * 0.8 + measuredOffset * 0.2) : measuredOffset;

      buffer.push({ t: msg.serverTime, ...msg });
      while (buffer.length > 60) buffer.shift();

      gameStateEl.textContent = msg.state;
      if (msg.countdownEndsAt) {
        const sec = Math.max(0, Math.ceil((msg.countdownEndsAt - now - serverOffset)/1000));
        countdownEl.textContent = (msg.state === 'countdown') ? sec : '—';
      } else countdownEl.textContent = '—';

      const me = msg.players.find(p => p.id === meId);
      scoreEl.textContent = me ? me.score : 0;
      // Ready is only meaningful in lobby & if not spectator
      readyBtn.disabled = !(msg.state === 'lobby' && me && !me.spectator);
      readyBtn.textContent = (me && me.ready) ? 'Ready ✓' : 'Ready';
    }
  };
  ws.onclose = () => { statusEl.textContent = 'disconnected'; };
}

joinBtn.addEventListener('click', () => connect(roomInput.value.trim() || 'lobby', nameInput.value.trim() || 'Player'));
readyBtn.addEventListener('click', () => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ready', ready: true }));
});

// Interpolation helpers
function lerp(a, b, t) { return a + (b - a) * t; }
function getRenderState() {
  if (buffer.length < 1) return null;
  const renderTime = Date.now() + serverOffset - INTERP_DELAY;

  let i = buffer.length - 1;
  while (i > 0 && buffer[i - 1].t > renderTime) i--;
  const a = buffer[Math.max(0, i - 1)];
  const b = buffer[i];
  if (!a || !b) return buffer[buffer.length - 1];

  const span = Math.max(1, b.t - a.t);
  const t = Math.min(1, Math.max(0, (renderTime - a.t) / span));

  const interpPlayers = b.players.map(pb => {
    const pa = a.players.find(p => p.id === pb.id) || pb;
    return { ...pb, y: lerp(pa.y, pb.y, t), vy: lerp(pa.vy ?? 0, pb.vy ?? 0, t) };
  });

  const interpPipes = b.pipes.map(pb => {
    const pa = a.pipes.find(p => p.id === pb.id) || pb;
    return { ...pb, x: lerp(pa.x, pb.x, t) };
  });

  return {
    w: b.w, h: b.h,
    state: b.state,
    countdownEndsAt: b.countdownEndsAt,
    constants: b.constants,
    players: interpPlayers,
    pipes: interpPipes
  };
}

// Input
function flap() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'flap' })); }
function restart() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'restart' })); }
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); flap(); }
  if (e.key.toLowerCase() === 'r') { restart(); }
});
canvas.addEventListener('mousedown', flap);
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); flap(); }, { passive: false });

// Rendering (skip spectators)
function draw() {
  const s = getRenderState();
  const w = 480, h = 800;
  ctx.clearRect(0,0,w,h);

  ctx.fillStyle = '#11151b';
  ctx.fillRect(0,0,w,h);
  ctx.fillStyle = '#2b2f38';
  ctx.fillRect(0,h-60,w,60);

  if (s) {
    const { players, pipes, constants } = s;
    const { BIRD_X, BIRD_RADIUS } = constants;

    // pipes
    ctx.fillStyle = '#49c36b';
    pipes.forEach(p => {
      ctx.fillRect(p.x - 30, 0, 60, p.top);
      ctx.fillRect(p.x - 30, p.bottom, 60, h - p.bottom - 60);
    });

    // players (no spectators drawn)
    players.filter(p => !p.spectator).forEach(p => {
      const isMe = p.id === meId;
      ctx.beginPath();
      ctx.fillStyle = isMe ? '#ffd166' : '#6aa0ff';
      ctx.arc(BIRD_X, p.y, BIRD_RADIUS + 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.font = '14px system-ui, sans-serif';
      const tag = `${p.name}${p.alive ? '' : ' ☠'}`;
      ctx.fillText(tag, BIRD_X - 26, p.y - (BIRD_RADIUS + 8));

      ctx.fillStyle = '#b3ffd2';
      ctx.font = 'bold 18px system-ui, sans-serif';
      ctx.fillText(String(p.score), BIRD_X - 5, p.y + 6);
    });

    // overlays
    if (s.state !== 'playing') {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0,0,w,h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '28px system-ui, sans-serif';
      let msg = s.state.toUpperCase();
      if (s.state === 'countdown' && s.countdownEndsAt) {
        const secs = Math.max(0, Math.ceil((s.countdownEndsAt - (Date.now() + serverOffset))/1000));
        msg = secs > 0 ? String(secs) : 'GO!';
      }
      if (s.state === 'lobby') msg = 'Waiting for players… Ready up!';
      if (s.state === 'gameover') msg = 'Round over — press R to restart';
      const textW = ctx.measureText(msg).width;
      ctx.fillText(msg, (w - textW) / 2, h * 0.45);
    }
  }

  requestAnimationFrame(draw);
}
draw();

// Auto-connect to lobby on load
connect('lobby', 'Player');
