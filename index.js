const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Game State (Stored in RAM - resets if server sleeps!)
let game = {
  players: {},
  status: "LOBBY",
  seekerId: null,
  timer: 0,
};

app.use(express.static("public"));

io.on("connection", (socket) => {
  socket.on("join", (name) => {
    game.players[socket.id] = {
      id: socket.id,
      name,
      status: "hiding",
      score: 0,
    };
    io.emit("sync", game);
  });

  // START LOGIC
  socket.on("start_game", () => {
    const ids = Object.keys(game.players);
    if (ids.length < 2) return;

    game.seekerId = ids[Math.floor(Math.random() * ids.length)];
    game.status = "HIDING";
    game.timer = 20; // 20 second hide time

    const countdown = setInterval(() => {
      game.timer--;
      if (game.timer <= 0) {
        game.status = "ACTIVE";
        clearInterval(countdown);
      }
      io.emit("sync", game);
    }, 1000);
  });

  // TAG LOGIC
  socket.on("tag", (targetId) => {
    if (socket.id !== game.seekerId) return;
    if (game.players[targetId]) {
      game.players[targetId].status = "caught";
      game.players[game.seekerId].score += 10;
      io.emit("sync", game);
    }
  });

  socket.on("disconnect", () => {
    delete game.players[socket.id];
    io.emit("sync", game);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game server active on port ${PORT}`));
