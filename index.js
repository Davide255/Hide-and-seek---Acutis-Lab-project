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
const DAY_TIME   = parseInt(process.env.DAY_TIME   || "60",  10);
const NIGHT_TIME  = parseInt(process.env.NIGHT_TIME  || "480", 10);

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

function generateCode(usedCodes = new Set()) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (usedCodes.has(code));
  return code;
}

function usedCodesInRoom(room) {
  return new Set(Object.values(room.players).map(p => p.code).filter(Boolean));
}

function createPlayer(socketId, name, role = "player") {
  return { id: socketId, name, role, status: "survivor", code: null, score: 0 };
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
    masterId: room.masterId,
    totalTurns: room.totalTurns,
    currentTurn: room.currentTurn,
    // codes are never exposed in room state — sent privately via your_code
    players: Object.values(room.players)
      .filter(p => !p.disconnected)
      .map(({ id, name, role, status, score }) => ({ id, name, role, status, score })),
    leaderboard: getLeaderboard(room),
    phaseTimeRemaining: room.phaseTimeRemaining,
  };
}

function aliveSurvivors(room) {
  return Object.values(room.players).filter(
    p => !p.disconnected && (p.status === "survivor" || p.status === "doctor" || p.status === "wounded")
  );
}

function allConverted(room) {
  return Object.values(room.players)
    .filter(p => !p.disconnected)
    .every(p => p.status === "seeker");
}

function calcDoctorCount(survivorCount) {
  if (survivorCount < 10) return 0;
  return Math.max(1, Math.floor(survivorCount * 0.1));
}

function assignDoctors(room) {
  // Reset previous night's doctors back to regular survivors
  Object.values(room.players).forEach(p => {
    if (p.status === "doctor") p.status = "survivor";
  });

  const eligible = Object.values(room.players).filter(
    p => !p.disconnected && p.status === "survivor"
  );
  const count = calcDoctorCount(eligible.length);
  const shuffled = eligible.slice().sort(() => Math.random() - 0.5);
  const doctors = shuffled.slice(0, count);
  doctors.forEach(p => { p.status = "doctor"; });
  return doctors;
}

// ─── Phase transitions ────────────────────────────────────────────────────────

function endGame(roomId, reason) {
  const room = rooms[roomId];
  if (!room || room.status === "FINISHED") return;
  clearInterval(room.countdownInterval);
  room.status = "FINISHED";
  room.countdownInterval = null;

  const winner = aliveSurvivors(room).length > 0 ? "survivors" : "seekers";

  io.to(roomId).emit("game_over", {
    winner,
    reason,
    room: getRoomState(room),
    leaderboard: getLeaderboard(room),
  });
}

function startNight(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.status = "NIGHT";
  room.phaseTimeRemaining = NIGHT_TIME;

  const doctors = assignDoctors(room);
  doctors.forEach(p => {
    io.to(p.id).emit("doctor_assigned", { yourCode: p.code });
  });

  io.to(roomId).emit("night_started", {
    turn: room.currentTurn,
    totalTurns: room.totalTurns,
    nightTime: NIGHT_TIME,
    room: getRoomState(room),
  });

  room.countdownInterval = setInterval(() => {
    room.phaseTimeRemaining--;
    io.to(roomId).emit("countdown", { phase: "NIGHT", timeRemaining: room.phaseTimeRemaining });
    if (room.phaseTimeRemaining <= 0) {
      clearInterval(room.countdownInterval);
      room.countdownInterval = null;
      endNight(roomId);
    }
  }, 1000);
}

function endNight(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Convert all wounded players who were not healed
  const converted = [];
  Object.values(room.players).forEach(p => {
    if (p.status === "wounded") {
      p.status = "seeker";
      p.code = null;
      converted.push({ id: p.id, name: p.name });
    }
  });

  if (allConverted(room)) { endGame(roomId, "all_converted"); return; }

  startDay(roomId, converted);
}

function startDay(roomId, convertedPlayers = []) {
  const room = rooms[roomId];
  if (!room) return;

  room.status = "DAY";
  room.phaseTimeRemaining = DAY_TIME;

  io.to(roomId).emit("day_started", {
    turn: room.currentTurn,
    totalTurns: room.totalTurns,
    convertedPlayers,
    dayTime: DAY_TIME,
    room: getRoomState(room),
  });

  room.countdownInterval = setInterval(() => {
    room.phaseTimeRemaining--;
    io.to(roomId).emit("countdown", { phase: "DAY", timeRemaining: room.phaseTimeRemaining });
    if (room.phaseTimeRemaining <= 0) {
      clearInterval(room.countdownInterval);
      room.countdownInterval = null;
      endDay(roomId);
    }
  }, 1000);
}

function endDay(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.currentTurn >= room.totalTurns) { endGame(roomId, "turns_ended"); return; }
  room.currentTurn++;
  startNight(roomId);
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
      totalTurns: 5,
      currentTurn: 1,
      phaseTimeRemaining: 0,
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

  // Master starts the game: assigns codes, picks first seeker, begins turn 1 night
  socket.on("start_game", ({ roomId, totalTurns } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    if (room.masterId !== socket.id)
      return socket.emit("error", { message: "Only the master can start the game" });
    if (room.status !== "LOBBY")
      return socket.emit("error", { message: "Game already in progress" });

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2)
      return socket.emit("error", { message: "Need at least 2 players to start" });

    const turns = parseInt(totalTurns, 10);
    if (!turns || turns < 1)
      return socket.emit("error", { message: "totalTurns must be a positive integer" });

    room.totalTurns = turns;
    room.currentTurn = 1;

    // Assign unique personal codes to all players
    const usedCodes = new Set();
    Object.values(room.players).forEach(p => {
      p.code = generateCode(usedCodes);
      usedCodes.add(p.code);
      p.status = "survivor";
    });

    // Pick one random seeker — seekers don't need a code
    const seekerId = playerIds[Math.floor(Math.random() * playerIds.length)];
    room.players[seekerId].status = "seeker";
    room.players[seekerId].code = null;

    // Send each survivor their code privately
    Object.values(room.players).forEach(p => {
      if (p.code) io.to(p.id).emit("your_code", { code: p.code });
    });

    io.to(roomId).emit("game_started", {
      seekerId,
      totalTurns: room.totalTurns,
      room: getRoomState(room),
    });

    startNight(roomId);
  });

  // Seeker tags a survivor by their personal code → survivor becomes "wounded"
  socket.on("tag", ({ roomId, targetCode } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    if (room.status !== "NIGHT")
      return socket.emit("error", { message: "Can only tag during night phase" });

    const tagger = room.players[socket.id];
    if (!tagger || tagger.status !== "seeker")
      return socket.emit("error", { message: "Only seekers can tag players" });
    if (!targetCode?.trim())
      return socket.emit("error", { message: "Target code is required" });

    const code = targetCode.trim().toUpperCase();
    const target = Object.values(room.players).find(p => p.code === code && !p.disconnected);
    if (!target) return socket.emit("error", { message: "Invalid code" });
    if (target.status !== "survivor" && target.status !== "doctor")
      return socket.emit("error", { message: "Player cannot be tagged" });

    target.status = "wounded";
    tagger.score += 10;

    io.to(roomId).emit("player_wounded", {
      targetId: target.id,
      targetName: target.name,
      room: getRoomState(room),
    });
  });

  // Doctor heals a wounded player by their personal code
  socket.on("heal", ({ roomId, targetCode } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    if (room.status !== "NIGHT")
      return socket.emit("error", { message: "Can only heal during night phase" });

    const doctor = room.players[socket.id];
    if (!doctor || doctor.status !== "doctor")
      return socket.emit("error", { message: "Only doctors can heal" });
    if (!targetCode?.trim())
      return socket.emit("error", { message: "Target code is required" });

    const code = targetCode.trim().toUpperCase();
    if (doctor.code === code)
      return socket.emit("error", { message: "Doctors cannot heal themselves" });

    const target = Object.values(room.players).find(p => p.code === code && !p.disconnected);
    if (!target) return socket.emit("error", { message: "Invalid code" });
    if (target.status !== "wounded")
      return socket.emit("error", { message: "Player is not wounded" });

    target.status = "survivor";
    // Regenerate code to prevent cheating / code reuse
    const used = usedCodesInRoom(room);
    used.delete(target.code);
    const newCode = generateCode(used);
    target.code = newCode;
    doctor.score += 5;

    io.to(target.id).emit("your_code", { code: newCode });

    io.to(roomId).emit("player_healed", {
      targetId: target.id,
      targetName: target.name,
      room: getRoomState(room),
    });
  });

  // Master can forcefully end the game at any time
  socket.on("end_game", ({ roomId } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    if (room.masterId !== socket.id)
      return socket.emit("error", { message: "Only the master can end the game" });
    endGame(roomId, "master_ended");
  });

  // Master resets a finished game back to LOBBY (scores are kept)
  socket.on("reset_game", ({ roomId } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", { message: "Room not found" });
    if (room.masterId !== socket.id)
      return socket.emit("error", { message: "Only the master can reset the game" });

    clearInterval(room.countdownInterval);
    room.status = "LOBBY";
    room.currentTurn = 1;
    room.totalTurns = 5;
    room.phaseTimeRemaining = 0;
    room.countdownInterval = null;
    Object.values(room.players).forEach(p => { p.status = "survivor"; p.code = null; });

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

    // Mark disconnected but keep slot alive for a grace period so they can rejoin
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

      const wasMaster = r.masterId === disconnectedSocketId;
      if (wasMaster) {
        const active = Object.keys(r.players).filter(id => !r.players[id].disconnected);
        const newMasterId = active[0] || Object.keys(r.players)[0];
        r.masterId = newMasterId;
        r.players[newMasterId].role = "master";
      }

      io.to(roomId).emit("player_left", {
        playerId: disconnectedSocketId,
        playerName: p.name,
        room: getRoomState(r),
      });

      if (r.status !== "LOBBY" && r.status !== "FINISHED" && allConverted(r)) {
        endGame(roomId, "all_converted");
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

    socket.join(id);

    // Re-send private code if the player is still a survivor/doctor/wounded
    if (player.code) io.to(socket.id).emit("your_code", { code: player.code });

    socket.emit("room_rejoined", {
      room: getRoomState(room),
      isMaster: room.masterId === socket.id,
      isDoctor: player.status === "doctor",
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
