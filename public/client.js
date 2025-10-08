// client.js — Player-following camera, respawn, countdown, interpolation
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const gameStateEl = document.getElementById('gameState');
const countdownEl = document.getElementById('countdown');
const progressEl = document.getElementById('progress');
const finishEl = document.getElementById('finish');
const roomInput = document.getElementById('room');
const nameInput = document.getElementById('name');
const joinBtn = document.getElementById('joinBtn');
const readyBtn = document.getElementById('readyBtn');

let ws, meId = null;
let buffer = [];
let serverOffset = 0;
const INTERP_DELAY = 120;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = 1920 * dpr;
  canvas.height = 1080 * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resizeCanvas(); addEventListener('resize', resizeCanvas);

function connect(room, name) {
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    statusEl.textContent = `connected (${room})`;
    ws.send(JSON.stringify({ type: 'join', roomId: room, name }));
  };
  ws.onclose = () => statusEl.textContent = 'disconnected';
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'joined') { meId = msg.id; return; }
    if (msg.type !== 'state') return;

    const now = Date.now();
    const measured = msg.serverTime - now;
    serverOffset = serverOffset ? (0.8 * serverOffset + 0.2 * measured) : measured;

    buffer.push({ t: msg.serverTime, ...msg });
    while (buffer.length > 60) buffer.shift();

    gameStateEl.textContent = msg.state;
    countdownEl.textContent = msg.countdownEndsAt ? Math.ceil((msg.countdownEndsAt - (now + serverOffset)) / 1000) : '—';
    const me = msg.players.find(p => p.id === meId);
    if (me) progressEl.textContent = me.progress;
    finishEl.textContent = msg.course?.finishPipes ?? '—';
  };
}

joinBtn.onclick = () => connect(roomInput.value || 'lobby', nameInput.value || 'Player');
readyBtn.onclick = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ready' })); };
window.addEventListener('keydown', e => { if (e.code === 'Space') flap(); if (e.key.toLowerCase() === 'r') restart(); });
canvas.addEventListener('mousedown', flap);
canvas.addEventListener('touchstart', flap, { passive: false });

function flap() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'flap' })); }
function restart() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'restart' })); }

function lerp(a, b, t) { return a + (b - a) * t; }
function interpolate() {
  if (!buffer.length) return null;
  const renderTime = Date.now() + serverOffset - INTERP_DELAY;
  let i = buffer.length - 1;
  while (i > 0 && buffer[i - 1].t > renderTime) i--;
  const a = buffer[Math.max(0, i - 1)];
  const b = buffer[i];
  const span = Math.max(1, b.t - a.t);
  const t = Math.min(1, Math.max(0, (renderTime - a.t) / span));

  const players = b.players.map(pb => {
    const pa = a.players.find(p => p.id === pb.id) || pb;
    return { ...pb, x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t) };
  });

  return { ...b, players };
}

function draw() {
  const s = interpolate();
  const w = 1920, h = 1080;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = '#10141b'; ctx.fillRect(0,0,w,h);
  ctx.fillStyle = '#232a33'; ctx.fillRect(0, h - 100, w, 100);

  if (!s || !s.course) {
    ctx.fillStyle = '#fff'; ctx.font = '32px sans-serif'; ctx.fillText('Connecting...', 820, 540);
    requestAnimationFrame(draw); return;
  }

  const me = s.players.find(p => p.id === meId);
  const leader = s.players.filter(p => !p.spectator).sort((a,b)=>b.x-a.x)[0];
  const camX = me && !me.spectator ? me.x : leader?.x || 0;
  const sx = x => (x - camX) + w/2;

  // Finish line
  const fx = sx(s.course.finishX);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.setLineDash([16,16]);
  ctx.beginPath(); ctx.moveTo(fx,0); ctx.lineTo(fx,h-100); ctx.stroke(); ctx.setLineDash([]);

  // Pipes
  ctx.fillStyle = '#49c36b';
  s.course.pipes.forEach(p => {
    const px = sx(p.x);
    if (px < -200 || px > w + 200) return;
    ctx.fillRect(px - s.course.pipeHalfW, 0, s.course.pipeHalfW*2, p.top);
    ctx.fillRect(px - s.course.pipeHalfW, p.bottom, s.course.pipeHalfW*2, h - p.bottom - 100);
  });

  // Players
  s.players.filter(p=>!p.spectator).forEach(p=>{
    const px = sx(p.x);
    if (px < -100 || px > w + 100) return;
    ctx.beginPath();
    ctx.fillStyle = p.id === meId ? '#ffd166' : '#6aa0ff';
    ctx.arc(px, p.y, 14, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '18px sans-serif';
    ctx.fillText(p.name, px - 30, p.y - 24);
    const ratio = (p.progress || 0) / (s.course.finishPipes || 1);
    ctx.fillStyle = '#2a2e36'; ctx.fillRect(px-50,p.y+20,100,10);
    ctx.fillStyle = p.id===meId ? '#b3ffd2':'#9ab7ff';
    ctx.fillRect(px-50,p.y+20,100*ratio,10);
  });

  // Overlays
  if (s.state !== 'playing') {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = '#fff'; ctx.font = '36px sans-serif';
    let msg = s.state.toUpperCase();
    if (s.state === 'countdown' && s.countdownEndsAt) {
      const secs = Math.max(0, Math.ceil((s.countdownEndsAt - (Date.now() + serverOffset)) / 1000));
      msg = secs > 0 ? secs : 'GO!';
    }
    if (s.state === 'lobby') msg = 'Waiting for players...';
    if (s.state === 'gameover') {
      const winner = s.players.find(p => p.id === s.winnerId);
      msg = winner ? `${winner.name} wins!` : 'Round Over';
    }
    const tw = ctx.measureText(msg).width;
    ctx.fillText(msg, (w - tw)/2, h*0.42);
  }

  requestAnimationFrame(draw);
}
draw();

// Auto-connect default
connect('lobby', 'Player');
