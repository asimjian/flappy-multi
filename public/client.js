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
resizeCanvas(); 
addEventListener('resize', resizeCanvas);

function connect(room, name) {
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  
  ws.onopen = () => {
    statusEl.textContent = `connecting...`;
    ws.send(JSON.stringify({ type: 'join', roomId: room, name }));
  };
  
  ws.onclose = () => {
    statusEl.textContent = 'disconnected';
    gameStateEl.textContent = 'disconnected';
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    statusEl.textContent = 'connection error';
  };
  
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      
      // Handle error messages from server
      if (msg.type === 'error') {
        console.error('Server error:', msg.message);
        statusEl.textContent = `Error: ${msg.message}`;
        return;
      }
      
      if (msg.type === 'joined') { 
        meId = msg.id;
        statusEl.textContent = `connected (${room})`;
        return; 
      }
      
      if (msg.type !== 'state') return;

      const now = Date.now();
      const measured = msg.serverTime - now;
      serverOffset = serverOffset ? (0.8 * serverOffset + 0.2 * measured) : measured;

      buffer.push({ t: msg.serverTime, ...msg });
      while (buffer.length > 60) buffer.shift();

      gameStateEl.textContent = msg.state;
      
      // Fixed countdown calculation
      if (msg.state === 'countdown' && msg.countdownEndsAt) {
        const timeLeft = Math.max(0, Math.ceil((msg.countdownEndsAt - (now + serverOffset)) / 1000));
        countdownEl.textContent = timeLeft;
      } else {
        countdownEl.textContent = '—';
      }
      
      const me = msg.players.find(p => p.id === meId);
      if (me) {
        progressEl.textContent = me.progress;
        // Update ready button state
        readyBtn.disabled = (msg.state !== 'lobby' || me.ready || me.spectator);
        readyBtn.textContent = me.ready ? 'Ready!' : 'Ready Up';
      }
      
      finishEl.textContent = msg.course?.finishPipes ?? '—';
      
    } catch (error) {
      console.error('Error parsing server message:', error);
    }
  };
}

joinBtn.onclick = () => {
  const room = roomInput.value || 'lobby';
  const name = nameInput.value || 'Player';
  if (!name.trim()) {
    alert('Please enter a name');
    return;
  }
  connect(room, name);
};

readyBtn.onclick = () => { 
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'ready' }));
    readyBtn.disabled = true;
  }
};

// Input handling with debouncing
let lastFlapTime = 0;
const FLAP_DEBOUNCE = 150;

function flap() {
  const now = Date.now();
  if (now - lastFlapTime < FLAP_DEBOUNCE) return;
  
  lastFlapTime = now;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'flap' }));
  }
}

function restart() { 
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'restart' }));
  }
}

// Event listeners with improved handling
window.addEventListener('keydown', e => { 
  if (e.code === 'Space') {
    e.preventDefault();
    flap(); 
  }
  if (e.key.toLowerCase() === 'r') {
    restart(); 
  }
});

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  flap();
});

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  flap();
}, { passive: false });

// Interpolation utilities
function lerp(a, b, t) { 
  return a + (b - a) * Math.min(1, Math.max(0, t)); 
}

function interpolate() {
  if (!buffer.length) return null;
  
  const renderTime = Date.now() + serverOffset - INTERP_DELAY;
  
  // Find the two snapshots to interpolate between
  let prevIndex = -1;
  let nextIndex = -1;
  
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].t <= renderTime) {
      prevIndex = i;
      break;
    }
  }
  
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i].t >= renderTime) {
      nextIndex = i;
      break;
    }
  }
  
  // If we don't have valid indices, use the latest snapshot
  if (prevIndex === -1 || nextIndex === -1) {
    return buffer[buffer.length - 1];
  }
  
  // If both indices are the same, no interpolation needed
  if (prevIndex === nextIndex) {
    return buffer[prevIndex];
  }
  
  const prev = buffer[prevIndex];
  const next = buffer[nextIndex];
  const span = Math.max(1, next.t - prev.t);
  const t = (renderTime - prev.t) / span;
  
  // Interpolate players
  const players = next.players.map(nextPlayer => {
    const prevPlayer = prev.players.find(p => p.id === nextPlayer.id);
    if (!prevPlayer) return nextPlayer;
    
    return {
      ...nextPlayer,
      x: lerp(prevPlayer.x, nextPlayer.x, t),
      y: lerp(prevPlayer.y, nextPlayer.y, t),
      vy: lerp(prevPlayer.vy, nextPlayer.vy, t)
    };
  });
  
  return { ...next, players };
}

function draw() {
  const s = interpolate();
  const w = 1920, h = 1080;
  
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#10141b'; 
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#232a33'; 
  ctx.fillRect(0, h - 100, w, 100);

  if (!s) {
    ctx.fillStyle = '#fff'; 
    ctx.font = '32px sans-serif'; 
    ctx.fillText('Connecting...', 820, 540);
    requestAnimationFrame(draw); 
    return;
  }

  const me = s.players.find(p => p.id === meId);
  const activePlayers = s.players.filter(p => !p.spectator);
  
  // Camera logic - follow current player or leader
  let camX = w / 2;
  if (me && !me.spectator) {
    camX = me.x;
  } else if (activePlayers.length > 0) {
    const leader = activePlayers.sort((a, b) => b.x - a.x)[0];
    camX = leader.x;
  }
  
  const sx = x => (x - camX) + w/2;

  // Draw finish line
  if (s.course && s.course.finishX) {
    const fx = sx(s.course.finishX);
    ctx.strokeStyle = '#fff'; 
    ctx.lineWidth = 4; 
    ctx.setLineDash([16, 16]);
    ctx.beginPath(); 
    ctx.moveTo(fx, 0); 
    ctx.lineTo(fx, h - 100); 
    ctx.stroke(); 
    ctx.setLineDash([]);
  }

  // Draw pipes
  if (s.course && s.course.pipes) {
    ctx.fillStyle = '#49c36b';
    s.course.pipes.forEach(p => {
      const px = sx(p.x);
      if (px < -200 || px > w + 200) return;
      
      // Top pipe
      ctx.fillRect(px - s.course.pipeHalfW, 0, s.course.pipeHalfW * 2, p.top);
      // Bottom pipe  
      ctx.fillRect(px - s.course.pipeHalfW, p.bottom, s.course.pipeHalfW * 2, h - p.bottom - 100);
    });
  }

  // Draw players
  if (s.players) {
    s.players.filter(p => !p.spectator).forEach(p => {
      const px = sx(p.x);
      if (px < -100 || px > w + 100) return;
      
      // Player circle
      ctx.beginPath();
      ctx.fillStyle = p.id === meId ? '#ffd166' : '#6aa0ff';
      ctx.arc(px, p.y, 14, 0, Math.PI * 2);
      ctx.fill();
      
      // Player name
      ctx.fillStyle = '#fff'; 
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.name, px, p.y - 24);
      ctx.textAlign = 'left';
      
      // Progress bar
      const ratio = (p.progress || 0) / (s.course?.finishPipes || 1);
      ctx.fillStyle = '#2a2e36'; 
      ctx.fillRect(px - 50, p.y + 20, 100, 10);
      ctx.fillStyle = p.id === meId ? '#b3ffd2' : '#9ab7ff';
      ctx.fillRect(px - 50, p.y + 20, 100 * ratio, 10);
    });
  }

  // Game state overlays
  if (s.state !== 'playing') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'; 
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff'; 
    ctx.font = '36px sans-serif';
    ctx.textAlign = 'center';
    
    let msg = s.state.toUpperCase();
    if (s.state === 'countdown' && s.countdownEndsAt) {
      const secs = Math.max(0, Math.ceil((s.countdownEndsAt - (Date.now() + serverOffset)) / 1000));
      msg = secs > 0 ? secs.toString() : 'GO!';
    } else if (s.state === 'lobby') {
      msg = 'Waiting for players...';
    } else if (s.state === 'gameover') {
      const winner = s.players.find(p => p.id === s.winnerId);
      msg = winner ? `${winner.name} wins!` : 'Round Over';
    }
    
    ctx.fillText(msg, w / 2, h * 0.42);
    ctx.textAlign = 'left';
  }

  requestAnimationFrame(draw);
}

// Start the game loop
draw();

// Auto-connect with default values
if (roomInput.value === '' && nameInput.value === '') {
  roomInput.value = 'lobby';
  nameInput.value = 'Player' + Math.floor(Math.random() * 1000);
}