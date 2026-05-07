const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
});

const RECONNECT_GRACE_MS = 30_000;

const HIDE_TIME = parseInt(process.env.HIDE_TIME || "20", 10);

// roomId → room object
const rooms = {};
// socketId → roomId (for fast disconnect lookup)
const socketToRoom = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateRoomId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function createPlayer(socketId, name, role = "player") {
  return { id: socketId, name, role, status: "safe", score: 0 };
}

function getLeaderboard(room) {
  return Object.values(room.players)
    .filter(p => !p.disconnected)
    .sort((a, b) => b.score - a.score)
    .map(({ id, name, score, status, role }) => ({ id, name, score, status, role }));
}

function getRoomState(room) {
  return {
    id: room.id,
    status: room.status,
    seekerId: room.seekerId,
    masterId: room.masterId,
    players: Object.values(room.players).filter(p => !p.disconnected),
    leaderboard: getLeaderboard(room),
    hideTimeRemaining: room.hideTimeRemaining,
  };
}

// Returns true when every non-seeker player has been caught
function checkAllCaught(room) {
  return Object.values(room.players).every(
    (p) => p.id === room.seekerId || p.status === "caught"
  );
}

function endGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.status === "FINISHED") return;
  clearInterval(room.countdownInterval);
  room.status = "FINISHED";
  room.countdownInterval = null;
  io.to(roomId).emit("game_over", {
    room: getRoomState(room),
    leaderboard: getLeaderboard(room),
  });
}

// ─── Socket.IO events ─────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  // Master creates a room and becomes the first player
  socket.on("create_room", ({ name } = {}) => {
    if (!name?.trim())
      return socket.emit("error", { message: "Name is required" });

    let roomId;
    do { roomId = generateRoomId(); } while (rooms[roomId]);

    const player = createPlayer(socket.id, name.trim(), "master");
    rooms[roomId] = {
      id: roomId,
      masterId: socket.id,
      players: { [socket.id]: player },
      status: "LOBBY",
      seekerId: null,
      hideTimeRemaining: 0,
      countdownInterval: null,
    };
    socketToRoom[socket.id] = roomId;
    socket.join(roomId);
    socket.emit("room_created", { roomId, player, room: getRoomState(rooms[roomId]) });
  });

  // Any player joins an existing room (LOBBY phase only)
  socket.on("join_room", ({ roomId, name } = {}) => {
    if (!name?.trim())
      return socket.emit("error", { message: "Name is required" });

    const id = roomId?.toUpperCase();
    const room = rooms[id];
    if (!room) return socket.emit("error", { message: "Room not found" });
    if (room.status !== "LOBBY")
      return socket.emit("error", { message: "Game already in progress" });

    const player = createPlayer(socket.id, name.trim());
    room.players[socket.id] = player;
    socketToRoom[socket.id] = id;
    socket.join(id);

    socket.emit("room_joined", { player, room: getRoomState(room) });
    socket.to(id).emit("player_joined", { player, room: getRoomState(room) });
  });

  // Master starts the game; random seeker is chosen, hiding countdown begins
  socket.on("start_game", ({ roomId } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    if (room.masterId !== socket.id)
      return socket.emit("error", { message: "Only the master can start the game" });
    if (room.status !== "LOBBY")
      return socket.emit("error", { message: "Game already in progress" });

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2)
      return socket.emit("error", { message: "Need at least 2 players to start" });

    room.seekerId = playerIds[Math.floor(Math.random() * playerIds.length)];
    Object.values(room.players).forEach((p) => {
      p.status = p.id === room.seekerId ? "seeking" : "hiding";
    });

    room.status = "HIDING";
    room.hideTimeRemaining = HIDE_TIME;

    io.to(roomId).emit("hiding_started", {
      seekerId: room.seekerId,
      hideTime: HIDE_TIME,
      room: getRoomState(room),
    });

    room.countdownInterval = setInterval(() => {
      room.hideTimeRemaining--;
      io.to(roomId).emit("countdown", { timeRemaining: room.hideTimeRemaining });
      if (room.hideTimeRemaining <= 0) {
        clearInterval(room.countdownInterval);
        room.countdownInterval = null;
        room.status = "ACTIVE";
        io.to(roomId).emit("game_active", { room: getRoomState(room) });
      }
    }, 1000);
  });

  // Seeker tags a hiding player (+10 points); auto-ends if all caught
  socket.on("tag", ({ roomId, targetId } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    if (room.status !== "ACTIVE")
      return socket.emit("error", { message: "Game is not active" });
    if (room.seekerId !== socket.id)
      return socket.emit("error", { message: "Only the seeker can tag players" });

    const target = room.players[targetId];
    if (!target) return socket.emit("error", { message: "Player not found" });
    if (target.status !== "hiding")
      return socket.emit("error", { message: "Player is already caught" });

    target.status = "caught";
    room.players[socket.id].score += 10;

    io.to(roomId).emit("player_tagged", {
      targetId,
      targetName: target.name,
      room: getRoomState(room),
    });

    if (checkAllCaught(room)) endGame(roomId);
  });

  // Master can forcefully end the game at any time
  socket.on("end_game", ({ roomId } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    if (room.masterId !== socket.id)
      return socket.emit("error", { message: "Only the master can end the game" });
    endGame(roomId);
  });

  // Master resets a finished/active game back to LOBBY (scores are kept)
  socket.on("reset_game", ({ roomId } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    if (room.masterId !== socket.id)
      return socket.emit("error", { message: "Only the master can reset the game" });

    clearInterval(room.countdownInterval);
    room.status = "LOBBY";
    room.seekerId = null;
    room.hideTimeRemaining = 0;
    room.countdownInterval = null;
    Object.values(room.players).forEach((p) => { p.status = "safe"; });

    io.to(roomId).emit("game_reset", { room: getRoomState(room) });
  });

  socket.on("disconnect", () => {
    const roomId = socketToRoom[socket.id];
    if (!roomId) return;
    delete socketToRoom[socket.id];

    const room = rooms[roomId];
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    // Mark disconnected but keep in room for a grace period so they can rejoin
    player.disconnected = true;
    const disconnectedSocketId = socket.id;

    const cleanupTimer = setTimeout(() => {
      const r = rooms[roomId];
      if (!r) return;
      const p = r.players[disconnectedSocketId];
      if (!p || !p.disconnected) return; // already rejoined

      delete r.players[disconnectedSocketId];

      if (Object.keys(r.players).length === 0) {
        clearInterval(r.countdownInterval);
        delete rooms[roomId];
        return;
      }

      const wasSeeker = r.seekerId === disconnectedSocketId;
      const wasMaster = r.masterId === disconnectedSocketId;

      if (wasMaster) {
        const activePlayers = Object.keys(r.players).filter(id => !r.players[id].disconnected);
        const newMasterId = activePlayers[0] || Object.keys(r.players)[0];
        r.masterId = newMasterId;
        r.players[newMasterId].role = "master";
      }

      io.to(roomId).emit("player_left", {
        playerId: disconnectedSocketId,
        playerName: p.name,
        room: getRoomState(r),
      });

      if (wasSeeker && (r.status === "HIDING" || r.status === "ACTIVE")) {
        endGame(roomId);
        return;
      }

      if ((r.status === "ACTIVE" || r.status === "HIDING") && checkAllCaught(r)) {
        endGame(roomId);
      }
    }, RECONNECT_GRACE_MS);

    player.cleanupTimer = cleanupTimer;
  });

  socket.on("rejoin_room", ({ roomId, name } = {}) => {
    const id = roomId?.toUpperCase();
    const room = rooms[id];
    if (!room) return socket.emit("error", { message: "Room not found" });

    // Find the disconnected slot for this player by name
    const oldEntry = Object.entries(room.players).find(
      ([, p]) => p.name === name && p.disconnected
    );

    if (!oldEntry) {
      // No pending slot — treat as a fresh join if still in lobby
      if (room.status !== "LOBBY")
        return socket.emit("error", { message: "Game in progress, cannot rejoin" });
      const player = createPlayer(socket.id, name.trim());
      room.players[socket.id] = player;
      socketToRoom[socket.id] = id;
      socket.join(id);
      socket.emit("room_joined", { player, room: getRoomState(room) });
      socket.to(id).emit("player_joined", { player, room: getRoomState(room) });
      return;
    }

    const [oldSocketId, player] = oldEntry;

    clearTimeout(player.cleanupTimer);
    delete player.cleanupTimer;
    delete player.disconnected;

    // Remap player to the new socket ID
    delete room.players[oldSocketId];
    player.id = socket.id;
    room.players[socket.id] = player;
    socketToRoom[socket.id] = id;

    if (room.masterId === oldSocketId) room.masterId = socket.id;
    if (room.seekerId === oldSocketId) room.seekerId = socket.id;

    socket.join(id);

    socket.emit("room_rejoined", {
      room: getRoomState(room),
      isMaster: room.masterId === socket.id,
    });
    socket.to(id).emit("player_rejoined", {
      playerName: player.name,
      room: getRoomState(room),
    });
  });
});

// ─── REST endpoints ───────────────────────────────────────────────────────────

app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/", (_, res) =>
  res.json({ status: "ok", activeRooms: Object.keys(rooms).length })
);

app.get("/rooms/:roomId", (req, res) => {
  const room = rooms[req.params.roomId.toUpperCase()];
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json(getRoomState(room));
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Game server active on port ${PORT}`));
}

module.exports = { app, server, io, rooms, socketToRoom };
