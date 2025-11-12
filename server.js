// server.js
'use strict';

/*
  Bouncy Volley — Multiplayer WebSocket server

  Features:
  - Multiple lobbies with live player counts (global broadcast: lobbyList + lobbyInfo)
  - First player in a lobby becomes HOST (can start game and kick players)
  - Basic session/room state: players, host, phase, scores
  - Server-side tick broadcasts room state at 30 Hz during game
  - Simple input model (left/right/jump) -> velocity updates; volleyball physics (light)
  - Safe guards for leave/disconnect; host reassignment; lobby cleanup when empty

  Notes:
  - This is an authoritative server skeleton. You can wire your client to:
      * request lobby list on connect
      * join a lobby with a display name
      * send input updates while in 'playing' phase
      * listen for state frames (state) to render other players and the volleyball
  - You can extend physics and rules to match exactly your single-player client logic later.
*/

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// --- Server bootstrap ---
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bouncy Volley server OK');
});
const wss = new WebSocket.Server({ server });

// --- In-memory state ---
const rooms = new Map(); // roomId -> Room
const clients = new Map(); // ws -> { id, roomId? }

const MAX_PLAYERS_PER_LOBBY = 4;
const TICK_HZ = 30;
const COURT = { width: 1200, height: 1600, netX: 600, groundY: 1450 };
const PHYSICS = { gravity: 800, friction: 0.8, vbGravityMultiplier: 0.5, vbBounce: 0.85 };

// --- Utilities ---
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const now = () => Date.now();

function send(ws, payload) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  } catch {}
}

function broadcastAll(payload) {
  const str = JSON.stringify(payload);
  for (const ws of wss.clients) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(str); } catch {}
  }
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      hostId: null,
      phase: 'lobby', // lobby | playing | ended
      players: new Map(), // playerId -> { id, name, ws, x,y,vx,vy, side, joinedAt }
      inputs: new Map(),  // playerId -> { left:boolean, right:boolean, jump:boolean }
      scores: { left: 0, right: 0 },
      vb: { x: 600, y: 300, vx: 0, vy: 0, radius: 26, scored: false },
      net: { x: 600, y: 800, width: 20, height: 250 },
      tickTimer: null,
      lastTickMs: now()
    });
  }
  return rooms.get(roomId);
}

function snapshotLobbyCounts() {
  const lobbies = [];
  for (const [id, room] of rooms.entries()) {
    lobbies.push({ id, count: room.players.size });
  }
  return lobbies;
}

function broadcastLobbyList() {
  broadcastAll({ type: 'lobbyList', lobbies: snapshotLobbyCounts() });
}

function broadcastLobbyInfo(roomId) {
  const room = rooms.get(roomId);
  broadcastAll({ type: 'lobbyInfo', room: roomId, count: room ? room.players.size : 0 });
}

function broadcastRoom(roomId, payload, exceptId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const str = JSON.stringify(payload);
  for (const [pid, p] of room.players.entries()) {
    if (exceptId && pid === exceptId) continue;
    const ws = p.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    try { ws.send(str); } catch {}
  }
}

function assignHostIfNeeded(room) {
  if (!room.hostId || !room.players.has(room.hostId)) {
    const order = Array.from(room.players.values()).sort((a, b) => a.joinedAt - b.joinedAt);
    room.hostId = order.length ? order[0].id : null;
  }
}

function removePlayerFromRoom(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.players.has(playerId)) {
    room.players.delete(playerId);
    room.inputs.delete(playerId);
    if (room.hostId === playerId) assignHostIfNeeded(room);
    broadcastRoom(roomId, { type: 'playerLeft', room: roomId, id: playerId });
    broadcastLobbyInfo(roomId);
    broadcastLobbyList();
    if (room.players.size === 0) {
      stopTick(room);
      rooms.delete(roomId);
      broadcastLobbyList();
    }
  }
}

// --- Game helpers ---
function resetPositions(room) {
  // Left side (player team), Right side (opponent team)
  // Place players evenly across their side
  const leftTeam = [];
  const rightTeam = [];
  for (const p of room.players.values()) {
    if (p.side === 'left') leftTeam.push(p);
    else rightTeam.push(p);
  }
  const baseY = COURT.groundY - 24;
  const leftXs = [150, 300];  // up to 2 slots
  const rightXs = [900, 1050];

  leftTeam.forEach((p, i) => {
    p.x = leftXs[i % leftXs.length];
    p.y = baseY;
    p.vx = 0; p.vy = 0;
  });
  rightTeam.forEach((p, i) => {
    p.x = rightXs[i % rightXs.length];
    p.y = baseY;
    p.vx = 0; p.vy = 0;
  });

  // Reset volleyball center with small random arc
  room.vb.x = 600;
  room.vb.y = 300;
  const dir = Math.random() < 0.5 ? -1 : 1;
  room.vb.vx = dir * 150;
  room.vb.vy = -120;
  room.vb.scored = false;
}

function startTick(room) {
  stopTick(room);
  room.lastTickMs = now();
  room.tickTimer = setInterval(() => tickRoom(room), Math.round(1000 / TICK_HZ));
}

function stopTick(room) {
  if (room.tickTimer) { clearInterval(room.tickTimer); room.tickTimer = null; }
}

function tickRoom(room) {
  const t = now();
  let dt = (t - room.lastTickMs) / 1000;
  room.lastTickMs = t;
  if (dt <= 0) dt = 0.016;
  if (dt > 0.1) dt = 0.1;

  if (room.phase !== 'playing') return;

  // Apply inputs -> velocities
  for (const [pid, p] of room.players.entries()) {
    const inp = room.inputs.get(pid) || { left: false, right: false, jump: false };
    let move = 0;
    if (inp.left) move -= 1;
    if (inp.right) move += 1;

    const moveSpeed = 3.5 * 60;
    p.vx = move * moveSpeed;

    // Simple jump: if on ground and jump flagged, apply vy impulse
    // Determine onGround by y position
    const onGround = (p.y + 24) >= COURT.groundY - 0.5;
    if (onGround && inp.jump) {
      p.vy = -550;
    }
  }

  // Physics: players
  for (const p of room.players.values()) {
    // gravity
    p.vy += PHYSICS.gravity * dt;
    // integrate
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // ground
    if (p.y + 24 >= COURT.groundY) {
      p.y = COURT.groundY - 24;
      p.vy = 0;
    }

    // friction on ground
    if (p.y + 24 >= COURT.groundY - 0.1) p.vx *= PHYSICS.friction;

    // net collision — prevent crossing
    const netLeft = room.net.x - room.net.width / 2;
    const netRight = room.net.x + room.net.width / 2;
    const netTop = room.net.y - room.net.height;
    const netBottom = room.net.y;

    const atNetHeight = (p.y + 24 > netTop && p.y - 24 < netBottom);
    const overlapsNetX = (p.x - 24 < netRight && p.x + 24 > netLeft);
    if (atNetHeight && overlapsNetX) {
      if (p.vx > 0) { p.x = netLeft - 24; p.vx = -Math.abs(p.vx) * 0.5; }
      else if (p.vx < 0) { p.x = netRight + 24; p.vx = Math.abs(p.vx) * 0.5; }
    }

    // side boundaries
    p.x = clamp(p.x, 24, COURT.width - 24);

    // keep on their side
    if (p.side === 'left' && p.x > room.net.x) { p.x = room.net.x; p.vx = 0; }
    if (p.side === 'right' && p.x < room.net.x) { p.x = room.net.x; p.vx = 0; }
  }

  // Volleyball physics
  const vb = room.vb;
  vb.vy += PHYSICS.gravity * PHYSICS.vbGravityMultiplier * dt;
  vb.x += vb.vx * dt;
  vb.y += vb.vy * dt;

  // minimal air resistance
  vb.vx *= 0.995;
  vb.vy *= 0.995;

  // net collision (vertical barrier)
  const netLeft = room.net.x - room.net.width / 2;
  const netRight = room.net.x + room.net.width / 2;
  const netTop = room.net.y - room.net.height;
  const netBottom = room.net.y;
  const atNetHeight = (vb.y + vb.radius > netTop && vb.y - vb.radius < netBottom);
  const overlapsNetX = (vb.x - vb.radius < netRight && vb.x + vb.radius > netLeft);
  if (atNetHeight && overlapsNetX) {
    if (vb.vx > 0) { vb.x = netLeft - vb.radius; vb.vx = -Math.abs(vb.vx) * PHYSICS.vbBounce; }
    else if (vb.vx < 0) { vb.x = netRight + vb.radius; vb.vx = Math.abs(vb.vx) * PHYSICS.vbBounce; }
  }

  // walls
  if (vb.x < vb.radius) { vb.x = vb.radius; vb.vx = Math.abs(vb.vx) * PHYSICS.vbBounce; }
  if (vb.x > COURT.width - vb.radius) { vb.x = COURT.width - vb.radius; vb.vx = -Math.abs(vb.vx) * PHYSICS.vbBounce; }

  // ground scoring
  if (vb.y + vb.radius >= COURT.groundY) {
    vb.y = COURT.groundY - vb.radius;
    vb.vx = 0; vb.vy = 0;
    if (!vb.scored) {
      vb.scored = true;
      // left side < net => right scores; right side > net => left scores
      if (vb.x < room.net.x) room.scores.right += 1;
      else room.scores.left += 1;

      // reset after short delay
      setTimeout(() => {
        vb.x = room.net.x;
        vb.y = 300;
        const dir = Math.random() < 0.5 ? -1 : 1;
        vb.vx = dir * 150;
        vb.vy = -120;
        vb.scored = false;
      }, 800);
    }
  }

  // ball-player collisions (simple circles)
  for (const p of room.players.values()) {
    const dx = vb.x - p.x;
    const dy = vb.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = vb.radius + 24;
    if (dist < minDist && dist > 0.001) {
      const nx = dx / dist, ny = dy / dist;
      const overlap = minDist - dist;
      vb.x += nx * (overlap + 1);
      vb.y += ny * (overlap + 1);
      // bounce with bias toward opposite side
      const velAlongNormal = vb.vx * nx + vb.vy * ny;
      if (velAlongNormal < 0) {
        vb.vx -= (1.3) * velAlongNormal * nx;
        vb.vy -= (1.3) * velAlongNormal * ny;
      }
      const towardsOpp = p.side === 'left' ? 1 : -1;
      vb.vx += towardsOpp * 120;
      if (vb.vy > -250) vb.vy = -320;
      // cap speed
      const speed = Math.hypot(vb.vx, vb.vy);
      const max = 900;
      if (speed > max) {
        const s = max / speed;
        vb.vx *= s; vb.vy *= s;
      }
    }
  }

  // Broadcast state frame to room
  const playersFrame = Array.from(room.players.values()).map(p => ({
    id: p.id, name: p.name, x: p.x, y: p.y, side: p.side
  }));
  broadcastRoom(room.id, {
    type: 'state',
    phase: room.phase,
    vb: { x: vb.x, y: vb.y },
    net: room.net,
    scores: room.scores,
    players: playersFrame
  });
}

// --- WS handlers ---
wss.on('connection', (ws) => {
  const playerId = makeId();
  clients.set(ws, { id: playerId, roomId: null });

  // Send id + current lobby list immediately
  send(ws, { type: 'id', id: playerId });
  send(ws, { type: 'lobbyList', lobbies: snapshotLobbyCounts() });

  ws.on('message', (raw) => {
    const msg = safeParse(raw);
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'listLobbies': {
        send(ws, { type: 'lobbyList', lobbies: snapshotLobbyCounts() });
        break;
      }

      case 'join': {
        const roomId = String(msg.room || 'lobby1');
        const name = String((msg.name || `Player-${playerId.slice(-4)}`)).slice(0, 24);
        const room = ensureRoom(roomId);

        if (room.players.size >= MAX_PLAYERS_PER_LOBBY) {
          send(ws, { type: 'error', message: 'Lobby full' });
          break;
        }

        // Assign side: balance teams (first two left, next two right)
        const leftCount = Array.from(room.players.values()).filter(p => p.side === 'left').length;
        const rightCount = room.players.size - leftCount;
        const side = leftCount <= rightCount ? 'left' : 'right';

        const joinedAt = now();
        room.players.set(playerId, { id: playerId, name, ws, x: (side === 'left' ? 300 : 900), y: COURT.groundY - 24, vx: 0, vy: 0, side, joinedAt });
        room.inputs.set(playerId, { left: false, right: false, jump: false });
        assignHostIfNeeded(room);

        clients.get(ws).roomId = roomId;

        // Send joined snapshot
        const playersSnap = Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, side: p.side }));
        send(ws, {
          type: 'joined',
          room: roomId,
          id: playerId,
          hostId: room.hostId,
          players: playersSnap,
          phase: room.phase
        });

        // Inform room
        broadcastRoom(roomId, { type: 'playerJoined', room: roomId, player: { id: playerId, name, side } }, playerId);

        // Update lobby counts globally
        broadcastLobbyInfo(roomId);
        broadcastLobbyList();

        break;
      }

      case 'leave': {
        const meta = clients.get(ws);
        if (!meta || !meta.roomId) break;
        removePlayerFromRoom(meta.roomId, playerId);
        meta.roomId = null;
        break;
      }

      case 'kick': {
        // Host-only: kick target from your room
        const meta = clients.get(ws);
        if (!meta || !meta.roomId) break;
        const room = rooms.get(meta.roomId);
        if (!room) break;
        if (room.hostId !== playerId) {
          send(ws, { type: 'error', message: 'Only host can kick.' });
          break;
        }
        const targetId = String(msg.targetId || '');
        if (!room.players.has(targetId)) {
          send(ws, { type: 'error', message: 'Player not in room.' });
          break;
        }
        const targetWs = room.players.get(targetId).ws;
        removePlayerFromRoom(room.id, targetId);
        // Notify kicked client (if still connected)
        send(targetWs, { type: 'kicked', room: room.id });
        break;
      }

      case 'startGame': {
        // Host-only: start the game
        const meta = clients.get(ws);
        if (!meta || !meta.roomId) break;
        const room = rooms.get(meta.roomId);
        if (!room) break;
        if (room.hostId !== playerId) {
          send(ws, { type: 'error', message: 'Only host can start.' });
          break;
        }
        if (room.players.size < 2) {
          send(ws, { type: 'error', message: 'Need at least 2 players to start.' });
          break;
        }
        room.phase = 'playing';
        room.scores = { left: 0, right: 0 };
        resetPositions(room);
        broadcastRoom(room.id, { type: 'gameStarted', room: room.id, hostId: room.hostId, players: Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, side: p.side })) });
        startTick(room);
        break;
      }

      case 'input': {
        // Client sends current input state while playing
        const meta = clients.get(ws);
        if (!meta || !meta.roomId) break;
        const room = rooms.get(meta.roomId);
        if (!room || room.phase !== 'playing') break;
        const left = !!msg.left;
        const right = !!msg.right;
        const jump = !!msg.jump;
        room.inputs.set(playerId, { left, right, jump });
        break;
      }

      default:
        send(ws, { type: 'error', message: 'Unknown message type' });
        break;
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    if (meta && meta.roomId) {
      removePlayerFromRoom(meta.roomId, playerId);
    }
    clients.delete(ws);
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Bouncy Volley server listening on ws://localhost:${PORT}`);
});

// Graceful shutdown
function shutdown() {
  try { wss.close(); } catch {}
  try { server.close(); } catch {}
  for (const room of rooms.values()) {
    try { stopTick(room); } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
