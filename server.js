// server.js (updated — uses "team" consistently instead of "side")
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 1000;
const GROUND_Y = 1450; // must match client ground level if used for simple physics

// Default lobby definitions
const DEFAULT_LOBBIES = [
  { id: 'Lobby-1', max: 4 },
  { id: 'Lobby-2', max: 4 },
  { id: 'Lobby-3', max: 4 },
  { id: 'Lobby-4', max: 4 }
];

// Rooms data structure
const rooms = {};
DEFAULT_LOBBIES.forEach(l => {
  rooms[l.id] = {
    id: l.id,
    max: l.max,
    players: new Map(), // playerId -> { id, name, team }
    hostId: null,
    phase: 'lobby', // 'lobby' or 'playing'
    scores: { left: 0, right: 0 },
    vb: { x: 600, y: 300, vx: 0, vy: 0 } // volleyball state
  };
});

// clients map: playerId -> { ws, name, roomId, team, x, y, vx, vy, input, onGround }
const clients = new Map();

const app = express();
// optional: serve a public folder if you want to host client from same server
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Utility send
function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    // ignore send errors
  }
}

// Broadcast lobby list to all connected clients
function broadcastLobbyList() {
  const lobbies = Object.values(rooms).map(r => ({ id: r.id, count: r.players.size, max: r.max }));
  const msg = JSON.stringify({ type: 'lobbyList', lobbies });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(msg); } catch (e) {}
    }
  });
}

// Broadcast to all players in a room
function broadcastToRoom(roomId, obj) {
  const room = rooms[roomId];
  if (!room) return;
  const msg = JSON.stringify(obj);
  room.players.forEach(p => {
    const client = clients.get(p.id);
    if (client && client.ws && client.ws.readyState === WebSocket.OPEN) {
      try { client.ws.send(msg); } catch (e) {}
    }
  });
}

// Helper to compute spawn positions based on team and index
function computeSpawn(team, index) {
  const leftBaseX = 225 + index * 40;
  const rightBaseX = 900 - index * 40;
  const y = GROUND_Y - 24;
  return team === 'left' ? { x: leftBaseX, y } : { x: rightBaseX, y };
}

// When a player leaves a room, update host and broadcast
function removePlayerFromRoom(playerId, roomId, reason) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.players.has(playerId)) {
    room.players.delete(playerId);
    // if host left, pick new host (first player)
    if (room.hostId === playerId) {
      const first = room.players.values().next();
      room.hostId = first.done ? null : first.value.id;
    }
    // notify remaining players
    broadcastToRoom(roomId, { type: 'playerLeft', id: playerId, reason });
    // update global lobby list
    broadcastLobbyList();
  }
}

// Basic authoritative game loop for rooms in 'playing' phase
const TICK_MS = 50;
setInterval(() => {
  Object.values(rooms).forEach(room => {
    if (room.phase !== 'playing') return;

    // update players
    const playersArray = [];
    room.players.forEach(p => {
      const client = clients.get(p.id);
      if (!client) return;
      // simple movement: left/right change x
      const speed = 8;
      if (client.input) {
        if (client.input.left) client.vx = -speed;
        else if (client.input.right) client.vx = speed;
        else client.vx = 0;
        if (client.input.jump && client.onGround) {
          client.vy = -18; // jump impulse
          client.onGround = false;
        }
      }
      // physics
      client.vy += 1.2; // gravity-ish
      client.x += client.vx;
      client.y += client.vy;
      if (client.y >= GROUND_Y - 24) {
        client.y = GROUND_Y - 24;
        client.vy = 0;
        client.onGround = true;
      }
      // clamp to court
      client.x = Math.max(40, Math.min(1160, client.x));
      playersArray.push({
        id: client.id,
        name: client.name,
        x: Math.round(client.x),
        y: Math.round(client.y),
        team: client.team // authoritative team value
      });
    });

    // simple volleyball physics
    const vb = room.vb;
    vb.vy += 1.2;
    vb.x += vb.vx;
    vb.y += vb.vy;
    // ground collision
    if (vb.y >= GROUND_Y - 26) {
      vb.y = GROUND_Y - 26;
      vb.vy = -vb.vy * 0.6;
      // score detection: left or right side
      if (vb.x < 600) {
        room.scores.right += 1;
        resetRound(room);
      } else {
        room.scores.left += 1;
        resetRound(room);
      }
    }
    // simple net collision
    const netX = 600;
    if (Math.abs(vb.x - netX) < 20 && vb.y > 700) {
      vb.vx *= -0.6;
      vb.vy *= 0.8;
    }

    // broadcast authoritative state
    broadcastToRoom(room.id, {
      type: 'state',
      players: playersArray,
      vb: { x: Math.round(vb.x), y: Math.round(vb.y) },
      scores: room.scores
    });
  });
}, TICK_MS);

// Reset round volleyball and player positions
function resetRound(room) {
  room.vb.x = 600;
  room.vb.y = 300;
  room.vb.vx = (Math.random() < 0.5 ? -1 : 1) * 6;
  room.vb.vy = -8;
  // reposition players to their team spawn
  let leftIndex = 0, rightIndex = 0;
  room.players.forEach(p => {
    const client = clients.get(p.id);
    if (!client) return;
    if (client.team === 'left') {
      const sp = computeSpawn('left', leftIndex++);
      client.x = sp.x; client.y = sp.y; client.vx = 0; client.vy = 0; client.onGround = true;
    } else {
      const sp = computeSpawn('right', rightIndex++);
      client.x = sp.x; client.y = sp.y; client.vx = 0; client.vy = 0; client.onGround = true;
    }
  });
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const id = uuidv4();
  // initial client record
  clients.set(id, {
    id,
    ws,
    name: null,
    roomId: null,
    team: 'left', // default team
    x: 225,
    y: GROUND_Y - 24,
    vx: 0,
    vy: 0,
    onGround: true,
    input: { left: false, right: false, jump: false }
  });

  // send assigned id
  send(ws, { type: 'id', id });

  // send current lobby list immediately
  broadcastLobbyList();

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const client = clients.get(id);
    if (!client) return;

    switch (msg.type) {
      case 'hello':
        // store name
        client.name = String(msg.name || `Player-${id.slice(0,4)}`).slice(0, 24);
        // reply with id again and lobby list
        send(ws, { type: 'id', id });
        broadcastLobbyList();
        break;

      case 'listLobbies':
        broadcastLobbyList();
        break;

      case 'join': {
        const roomId = String(msg.room);
        const name = String(msg.name || client.name || `Player-${id.slice(0,4)}`).slice(0, 24);
        const room = rooms[roomId];
        if (!room) {
          send(ws, { type: 'error', message: 'Room not found' });
          break;
        }
        if (room.players.size >= room.max) {
          send(ws, { type: 'error', message: 'Room full' });
          break;
        }
        // if already in another room, remove
        if (client.roomId && client.roomId !== roomId) {
          removePlayerFromRoom(id, client.roomId, 'moved');
        }
        client.name = name;
        client.roomId = roomId;
        // default team: left (host can change)
        client.team = client.team || 'left';
        // compute spawn index for that team
        const sideCount = Array.from(room.players.values()).filter(p => p.team === client.team).length;
        const sp = computeSpawn(client.team, sideCount);
        client.x = sp.x; client.y = sp.y; client.vx = 0; client.vy = 0; client.onGround = true;
        room.players.set(id, { id, name: client.name, team: client.team });
        // assign host if none
        if (!room.hostId) room.hostId = id;
        // notify joining client
        send(ws, {
          type: 'joined',
          room: roomId,
          hostId: room.hostId,
          phase: room.phase,
          players: Array.from(room.players.values())
        });
        // notify others in room
        broadcastToRoom(roomId, { type: 'playerJoined', player: { id, name: client.name, team: client.team } });
        // update lobby list globally
        broadcastLobbyList();
        break;
      }

      case 'assignTeam': {
        const roomId = client.roomId;
        if (!roomId) break;
        const room = rooms[roomId];
        if (!room) break;
        // only host can assign
        if (room.hostId !== id) {
          send(ws, { type: 'error', message: 'Only host can assign teams' });
          break;
        }
        const targetId = String(msg.playerId);
        const team = msg.team === 'right' ? 'right' : 'left';
        const targetClient = clients.get(targetId);
        if (!targetClient || targetClient.roomId !== roomId) break;
        // update authoritative client record
        targetClient.team = team;
        // update room players map
        const p = room.players.get(targetId);
        if (p) { p.team = team; room.players.set(targetId, p); }
        // compute new index among players on that team (after update)
        const sideIndex = Array.from(room.players.values()).filter(x => x.team === team).findIndex(x => x.id === targetId);
        const sp = computeSpawn(team, Math.max(0, sideIndex));
        targetClient.x = sp.x; targetClient.y = sp.y; targetClient.vx = 0; targetClient.vy = 0; targetClient.onGround = true;
        // broadcast update to room (use "team" property)
        broadcastToRoom(roomId, { type: 'playerUpdated', player: { id: targetId, name: targetClient.name, team } });
        break;
      }

      case 'kick': {
        const roomId = client.roomId;
        if (!roomId) break;
        const room = rooms[roomId];
        if (!room) break;
        if (room.hostId !== id) {
          send(ws, { type: 'error', message: 'Only host can kick' });
          break;
        }
        const targetId = String(msg.playerId);
        const targetClient = clients.get(targetId);
        if (targetClient && targetClient.roomId === roomId) {
          // notify kicked client
          send(targetClient.ws, { type: 'kicked', reason: 'kicked by host' });
          // remove from room
          removePlayerFromRoom(targetId, roomId, 'kicked');
          // optionally close their socket
          try { targetClient.ws.close(); } catch (e) {}
          // update lobby list
          broadcastLobbyList();
        }
        break;
      }

      case 'startGame': {
        const roomId = client.roomId;
        if (!roomId) break;
        const room = rooms[roomId];
        if (!room) break;
        if (room.hostId !== id) {
          send(ws, { type: 'error', message: 'Only host can start the game' });
          break;
        }
        // set phase and initialize positions and volleyball
        room.phase = 'playing';
        room.scores = { left: 0, right: 0 };
        room.vb = { x: 600, y: 300, vx: (Math.random() < 0.5 ? -1 : 1) * 6, vy: -8 };
        // initialize player physics state and ensure team values are authoritative
        let leftIndex = 0, rightIndex = 0;
        room.players.forEach(p => {
          const c = clients.get(p.id);
          if (!c) return;
          if (c.team === 'left') {
            const sp = computeSpawn('left', leftIndex++);
            c.x = sp.x; c.y = sp.y; c.vx = 0; c.vy = 0; c.onGround = true;
          } else {
            const sp = computeSpawn('right', rightIndex++);
            c.x = sp.x; c.y = sp.y; c.vx = 0; c.vy = 0; c.onGround = true;
          }
        });
        // broadcast gameStarted and include players with team property
        broadcastToRoom(roomId, {
          type: 'gameStarted',
          players: Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, team: p.team }))
        });
        break;
      }

      case 'ping':
        // reply with pong and original timestamp
        send(ws, { type: 'pong', ts: msg.ts || Date.now() });
        break;

      case 'input':
        // store input for authoritative loop
        if (client) {
          client.input = {
            left: !!msg.left,
            right: !!msg.right,
            jump: !!msg.jump
          };
        }
        break;

      default:
        // unknown message
        break;
    }
  });

  ws.on('close', () => {
    const client = clients.get(id);
    if (!client) {
      clients.delete(id);
      return;
    }
    const roomId = client.roomId;
    if (roomId) removePlayerFromRoom(id, roomId, 'disconnect');
    clients.delete(id);
    broadcastLobbyList();
  });

  ws.on('error', () => {
    // ignore
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
