const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const scoreEl  = document.getElementById('score');
const roomInput = document.getElementById('room');
const nameInput = document.getElementById('name');
const joinBtn = document.getElementById('joinBtn');

let ws;
let meId = null;
let state = {
  w: canvas.width,
  h: canvas.height,
  pipes: [],
  players: [],
  constants: { BIRD_X: 100, BIRD_RADIUS: 12 }
};

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
    if (msg.type === 'joined') meId = msg.id;
    if (msg.type === 'state') {
      state = msg;
      const me = state.players.find(p => p.id === meId);
      scoreEl.textContent = me ? me.score : 0;
    }
  };
  ws.onclose = () => { statusEl.textContent = 'disconnected'; };
}

joinBtn.addEventListener('click', () => connect(roomInput.value.trim() || 'lobby', nameInput.value.trim() || 'Player'));

function flap() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'flap' }));
}
function restart() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'restart' }));
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); flap(); }
  if (e.key.toLowerCase() === 'r') { restart(); }
});
canvas.addEventListener('mousedown', flap);
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); flap(); }, { passive: false });

function draw() {
  const { w, h, pipes, players, constants } = state;
  const { BIRD_X, BIRD_RADIUS } = constants;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = '#1a1d22';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = '#2a2e36';
  ctx.fillRect(0, h-40, w, 40);
  ctx.fillStyle = '#49c36b';
  pipes.forEach(p => {
    ctx.fillRect(p.x - 25, 0, 50, p.top);
    ctx.fillRect(p.x - 25, p.bottom, 50, h - p.bottom - 40);
  });
  players.forEach((p) => {
    const isMe = p.id === meId;
    ctx.beginPath();
    ctx.fillStyle = isMe ? '#ffd166' : '#6aa0ff';
    ctx.arc(BIRD_X, p.y, BIRD_RADIUS, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '12px sans-serif';
    const tag = `${p.name}${p.alive ? '' : ' ☠'}`;
    ctx.fillText(tag, BIRD_X - 20, p.y - BIRD_RADIUS - 6);
    ctx.fillStyle = '#b3ffd2';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(p.score.toString(), BIRD_X - 4, p.y + 5);
  });
  requestAnimationFrame(draw);
}
draw();

connect('lobby', 'Player');