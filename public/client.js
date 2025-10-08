// client.js — Player-follow camera, fixed course, interpolation, spectators & room browser.

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const statusEl = document.getElementById('status');
const roomInput = document.getElementById('room');
const nameInput = document.getElementById('name');
const joinBtn = document.getElementById('joinBtn');
const readyBtn = document.getElementById('readyBtn');
const gameStateEl = document.getElementById('gameState');
const countdownEl = document.getElementById('countdown');
const progressEl = document.getElementById('progress');
const finishEl  = document.getElementById('finish');
const refreshRoomsBtn = document.getElementById('refreshRooms');
const roomsListEl = document.getElementById('roomsList');

let ws, meId = null;

// Interpolation buffer
const buffer = [];
const INTERP_DELAY = 120;  // ms
let serverOffset = 0;

// DPR scaling
function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 1920 * dpr;
  canvas.height = 1080 * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
sizeCanvas();
addEventListener('resize', sizeCanvas);

// -------- Room browser --------
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
  } catch {
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
  const wrapper = document.createElement('div'); wrapper.className = 'room-item';
  return [name, state, players, specs, ready, (wrapper.appendChild(join), join)];
}
refreshRoomsBtn.addEventListener('click', loadRooms);
setInterval(loadRooms, 5000);
loadRooms();

// -------- Networking --------
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
        const sec = Math.max(0, Math.ceil((msg.countdownEndsAt - now - serverOffset) / 1000));
        countdownEl.textContent = (msg.state === 'countdown') ? sec : '—';
      } else countdownEl.textContent = '—';

      if (msg.course) {
        finishEl.textContent = msg.course.finishPipes ?? '—';
      }

      const me = msg.players.find(p => p.id === meId);
      progressEl.textContent = me ? (me.progress ?? 0) : 0;
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

// Input
function flap() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'flap' })); }
function restart() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'restart' })); }
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); flap(); }
  if (e.key.toLowerCase() === 'r') { restart(); }
});
canvas.addEventListener('mousedown', flap);
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); flap(); }, { passive: false });

// -------- Interpolation & camera --------
function lerp(a, b, t) { return a + (b - a) * t; }

function getInterpolatedState() {
  if (buffer.length < 1) return null;
  const renderTime = Date.now() + serverOffset - INTERP_DELAY;

  let i = buffer.length - 1;
  while (i > 0 && buffer[i - 1].t > renderTime) i--;
  const a = buffer[Math.max(0, i - 1)];
  const b = buffer[i];
  if (!a || !b) return buffer[buffer.length - 1];

  const span = Math.max(1, b.t - a.t);
  const t = Math.min(1, Math.max(0, (renderTime - a.t) / span));

  // Interpolate players (x, y, vy)
  const players = b.players.map(pb => {
    const pa = a.players.find(p => p.id === pb.id) || pb;
    return {
      ...pb,
      x: lerp(pa.x, pb.x, t),
      y: lerp(pa.y, pb.y, t),
      vy: lerp(pa.vy ?? 0, pb.vy ?? 0, t)
    };
  });

  // Course/pipes are static; carry from latest 'b'
  return {
    state: b.state,
    countdownEndsAt: b.countdownEndsAt,
    winnerId: b.winnerId,
    view: b.view,
    course: b.course,
    players
  };
}

function getCameraX(s) {
  // Follow me; if spectator or missing, follow the leader
  const me = s.players.find(p => p.id === meId);
  const target = (me && !me.spectator) ? me : s.players
    .filter(p => !p.spectator)
    .sort((p1, p2) => p2.x - p1.x)[0];
  return target ? target.x : 0;
}

// -------- Rendering --------
function draw() {
  const s = getInterpolatedState();
  const w = 1920, h = 1080;
  ctx.clearRect(0,0,w,h);

  // Background & ground
  ctx.fillStyle = '#10141b';
  ctx.fillRect(0,0,w,h);
  ctx.fillStyle = '#232a33';
  ctx.fillRect(0, h - (s?.view?.groundH ?? 100), w, (s?.view?.groundH ?? 100));

  if (s && s.course) {
    const camX = getCameraX(s);
    const half = w / 2;

    // Helper to convert world->screen X
    const sx = (worldX) => (worldX - camX) + half;

    // Finish line (static world position)
    const finishSX = sx(s.course.finishX);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.setLineDash([16,16]);
    ctx.beginPath();
    ctx.moveTo(finishSX, 0);
    ctx.lineTo(finishSX, h - s.view.groundH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Pipes (fixed world x)
    ctx.fillStyle = '#49c36b';
    s.course.pipes.forEach(p => {
      const px = sx(p.x);
      // Cull if off-screen
      if (px < -200 || px > w + 200) return;
      ctx.fillRect(px - s.course.pipeHalfW, 0, s.course.pipeHalfW*2, p.top);
      ctx.fillRect(px - s.course.pipeHalfW, p.bottom, s.course.pipeHalfW*2, h - p.bottom - s.view.groundH);
    });

    // Players (skip spectators)
    s.players.filter(p => !p.spectator).forEach(p => {
      const px = sx(p.x);
      if (px < -100 || px > w + 100) return;
      const isMe = p.id === meId;
      ctx.beginPath();
      ctx.fillStyle = isMe ? '#ffd166' : '#6aa0ff';
      ctx.arc(px, p.y, 16, 0, Math.PI * 2);
      ctx.fill();

      // name
      ctx.fillStyle = '#fff';
      ctx.font = '18px system-ui, sans-serif';
      ctx.fillText(p.name, px - 30, p.y - 22);

      // progress bar
      const barW = 200, barH = 12, bx = px - barW/2, by = p.y + 24;
      const ratio = (p.progress || 0) / (s.course.finishPipes || 1);
      ctx.fillStyle = '#2a2e36'; ctx.fillRect(bx, by, barW, barH);
      ctx.fillStyle = isMe ? '#b3ffd2' : '#9ab7ff';
      ctx.fillRect(bx, by, Math.max(0, Math.min(barW, barW * ratio)), barH);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(bx, by, barW, barH);
    });

    // Overlays
    ctx.fillStyle = '#ffffff';
    if (s.state !== 'playing') {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0,0,w,h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '36px system-ui, sans-serif';
      let msg = s.state.toUpperCase();
      if (s.state === 'countdown' && s.countdownEndsAt) {
        const secs = Math.max(0, Math.ceil((s.countdownEndsAt - (Date.now() + serverOffset))/1000));
        msg = secs > 0 ? String(secs) : 'GO!';
      }
      if (s.state === 'lobby') msg = 'Waiting for players… Ready up!';
      if (s.state === 'gameover') {
        const winner = s.players.find(p => p.id === s.winnerId);
        msg = winner ? `${winner.name} wins!` : 'Round over';
      }
      const textW = ctx.measureText(msg).width;
      ctx.fillText(msg, (w - textW) / 2, h * 0.42);
    }
  }

  requestAnimationFrame(draw);
}
draw();

// -------- Auto-connect --------
function flap() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'flap' })); }
function restart() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'restart' })); }
addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); flap(); } if (e.key.toLowerCase() === 'r') { restart(); } });
canvas.addEventListener('mousedown', flap);
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); flap(); }, { passive: false });

connect('lobby', 'Player');
