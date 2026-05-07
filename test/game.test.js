// Use a 1-second hide time so countdown tests finish quickly
process.env.HIDE_TIME = "1";

const { server, io, rooms, socketToRoom } = require("../index");
const Client = require("socket.io-client");

jest.setTimeout(15000);

let port;
const clientSockets = [];

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll((done) => {
  server.listen(0, () => {
    port = server.address().port;
    done();
  });
});

afterAll((done) => {
  io.close();
  server.close(done);
});

afterEach(async () => {
  // Disconnect every test client and wait for server-side cleanup
  await Promise.all(
    clientSockets.map(
      (s) =>
        new Promise((resolve) => {
          if (s.connected) {
            s.once("disconnect", resolve);
            s.disconnect();
          } else {
            resolve();
          }
        })
    )
  );
  clientSockets.length = 0;

  // Force-clear any state left by failed tests
  Object.values(rooms).forEach((r) => clearInterval(r.countdownInterval));
  Object.keys(rooms).forEach((k) => delete rooms[k]);
  Object.keys(socketToRoom).forEach((k) => delete socketToRoom[k]);
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function connect() {
  const s = Client(`http://localhost:${port}`);
  clientSockets.push(s);
  return s;
}

function on(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timeout waiting for "${event}"`)),
      timeout
    );
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function connected(socket) {
  if (socket.connected) return;
  await on(socket, "connect");
}

// Creates a room and returns { master, roomId }
async function makeRoom(masterName = "Master") {
  const master = connect();
  await connected(master);
  const p = on(master, "room_created");
  master.emit("create_room", { name: masterName });
  const { roomId } = await p;
  return { master, roomId };
}

// Joins a room and returns the player socket
async function joinRoom(roomId, name) {
  const socket = connect();
  await connected(socket);
  const p = on(socket, "room_joined");
  socket.emit("join_room", { roomId, name });
  await p;
  return socket;
}

// Starts the game (master emits start_game) and waits for hiding_started
async function startGame(master, roomId) {
  const p = on(master, "hiding_started");
  master.emit("start_game", { roomId });
  return p;
}

// Waits until the game transitions to ACTIVE (countdown expires)
function waitForActive(socket) {
  return on(socket, "game_active", 5000);
}

// ─── Room management ──────────────────────────────────────────────────────────

describe("Room management", () => {
  test("create_room returns a valid room with master player", async () => {
    const master = connect();
    await connected(master);
    const p = on(master, "room_created");
    master.emit("create_room", { name: "Alice" });
    const data = await p;

    expect(data.roomId).toMatch(/^[A-Z0-9]{6}$/);
    expect(data.player.name).toBe("Alice");
    expect(data.player.role).toBe("master");
    expect(data.room.status).toBe("LOBBY");
    expect(data.room.players).toHaveLength(1);
  });

  test("create_room rejects empty name", async () => {
    const s = connect();
    await connected(s);
    const p = on(s, "error");
    s.emit("create_room", { name: "  " });
    const err = await p;
    expect(err.message).toBe("Name is required");
  });

  test("join_room adds player and notifies room", async () => {
    const { master, roomId } = await makeRoom("Master");
    const playerJoinedOnMaster = on(master, "player_joined");

    const player = connect();
    await connected(player);
    const p = on(player, "room_joined");
    player.emit("join_room", { roomId, name: "Bob" });

    const [joinData, notif] = await Promise.all([p, playerJoinedOnMaster]);
    expect(joinData.player.name).toBe("Bob");
    expect(joinData.room.players).toHaveLength(2);
    expect(notif.player.name).toBe("Bob");
  });

  test("join_room is case-insensitive for room ID", async () => {
    const { roomId } = await makeRoom();
    const player = connect();
    await connected(player);
    const p = on(player, "room_joined");
    player.emit("join_room", { roomId: roomId.toLowerCase(), name: "Bob" });
    const data = await p;
    expect(data.player.name).toBe("Bob");
  });

  test("join_room rejects unknown room", async () => {
    const s = connect();
    await connected(s);
    const p = on(s, "error");
    s.emit("join_room", { roomId: "XXXXXX", name: "Ghost" });
    const err = await p;
    expect(err.message).toBe("Room not found");
  });

  test("join_room rejects empty name", async () => {
    const { roomId } = await makeRoom();
    const s = connect();
    await connected(s);
    const p = on(s, "error");
    s.emit("join_room", { roomId, name: "" });
    const err = await p;
    expect(err.message).toBe("Name is required");
  });

  test("join_room rejects when game is already in progress", async () => {
    const { master, roomId } = await makeRoom("Master");
    await joinRoom(roomId, "Player1");
    await startGame(master, roomId);

    const late = connect();
    await connected(late);
    const p = on(late, "error");
    late.emit("join_room", { roomId, name: "LatePlayer" });
    const err = await p;
    expect(err.message).toBe("Game already in progress");
  });
});

// ─── Game start ───────────────────────────────────────────────────────────────

describe("Game start", () => {
  test("start_game fails with only one player", async () => {
    const { master, roomId } = await makeRoom("Solo");
    const p = on(master, "error");
    master.emit("start_game", { roomId });
    const err = await p;
    expect(err.message).toBe("Need at least 2 players to start");
  });

  test("start_game fails for non-master", async () => {
    const { roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1");
    const p = on(player, "error");
    player.emit("start_game", { roomId });
    const err = await p;
    expect(err.message).toBe("Only the master can start the game");
  });

  test("start_game fails if game already in progress", async () => {
    const { master, roomId } = await makeRoom("Master");
    await joinRoom(roomId, "Player1");
    await startGame(master, roomId);

    const p = on(master, "error");
    master.emit("start_game", { roomId });
    const err = await p;
    expect(err.message).toBe("Game already in progress");
  });

  test("start_game emits hiding_started with seekerId to all players", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1");

    const [dataM, dataP] = await Promise.all([
      on(master, "hiding_started"),
      on(player, "hiding_started"),
      new Promise((r) => { master.emit("start_game", { roomId }); r(); }),
    ]);

    expect(dataM.seekerId).toBeTruthy();
    expect(dataM.seekerId).toBe(dataP.seekerId);
    expect(dataM.hideTime).toBe(1); // HIDE_TIME env override
    expect(dataM.room.status).toBe("HIDING");
  });

  test("seeker status is 'seeking', others are 'hiding'", async () => {
    const { master, roomId } = await makeRoom("Master");
    await joinRoom(roomId, "Player1");

    const data = await startGame(master, roomId);
    const seeker = data.room.players.find((p) => p.id === data.seekerId);
    const hiders = data.room.players.filter((p) => p.id !== data.seekerId);

    expect(seeker.status).toBe("seeking");
    hiders.forEach((h) => expect(h.status).toBe("hiding"));
  });
});

// ─── Countdown & ACTIVE transition ───────────────────────────────────────────

describe("Countdown and ACTIVE phase", () => {
  test("countdown ticks and transitions to ACTIVE", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1");

    // Collect countdown ticks
    const ticks = [];
    master.on("countdown", (d) => ticks.push(d.timeRemaining));

    await startGame(master, roomId);

    // Wait for game_active from both sockets
    const [activeM, activeP] = await Promise.all([
      waitForActive(master),
      waitForActive(player),
    ]);

    expect(activeM.room.status).toBe("ACTIVE");
    expect(activeP.room.status).toBe("ACTIVE");
    expect(ticks.length).toBeGreaterThan(0);
  });
});

// ─── Tagging ─────────────────────────────────────────────────────────────────

describe("Tagging", () => {
  // Helper: start game and wait for ACTIVE phase, then identify seeker/hiders
  async function setupActiveGame() {
    const { master, roomId } = await makeRoom("Master");
    const player1 = await joinRoom(roomId, "Player1");
    const player2 = await joinRoom(roomId, "Player2");

    const hiding = await startGame(master, roomId);
    const seekerId = hiding.seekerId;

    // Map socket -> id
    const sockets = { [master.id]: master, [player1.id]: player1, [player2.id]: player2 };
    const seekerSocket = sockets[seekerId];
    const hiderSockets = Object.entries(sockets)
      .filter(([id]) => id !== seekerId)
      .map(([, s]) => s);

    await Promise.all([waitForActive(master), waitForActive(player1), waitForActive(player2)]);
    return { master, player1, player2, roomId, seekerId, seekerSocket, hiderSockets };
  }

  test("non-seeker cannot tag", async () => {
    const { hiderSockets, roomId, seekerId } = await setupActiveGame();
    const hider = hiderSockets[0];
    const p = on(hider, "error");
    hider.emit("tag", { roomId, targetId: seekerId });
    const err = await p;
    expect(err.message).toBe("Only the seeker can tag players");
  });

  test("seeker tags a hider; hider status becomes 'caught' and seeker scores +10", async () => {
    const { seekerSocket, hiderSockets, roomId } = await setupActiveGame();
    const target = hiderSockets[0];
    const p = on(seekerSocket, "player_tagged");
    seekerSocket.emit("tag", { roomId, targetId: target.id });
    const data = await p;

    expect(data.targetId).toBe(target.id);
    const taggedPlayer = data.room.players.find((pl) => pl.id === target.id);
    expect(taggedPlayer.status).toBe("caught");
    const seeker = data.room.players.find((pl) => pl.id === seekerSocket.id);
    expect(seeker.score).toBe(10);
  });

  test("seeker cannot tag an already caught player", async () => {
    const { seekerSocket, hiderSockets, roomId } = await setupActiveGame();
    const target = hiderSockets[0];

    seekerSocket.emit("tag", { roomId, targetId: target.id });
    await on(seekerSocket, "player_tagged");

    const p = on(seekerSocket, "error");
    seekerSocket.emit("tag", { roomId, targetId: target.id });
    const err = await p;
    expect(err.message).toBe("Player is already caught");
  });

  test("tag fails when game is not ACTIVE", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1");

    // Game is in LOBBY — seeker doesn't exist yet, test with master
    const p = on(master, "error");
    master.emit("tag", { roomId, targetId: player.id });
    const err = await p;
    expect(err.message).toBe("Game is not active");
  });

  test("game_over fires automatically when all hiders are caught", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1"); // Only 1 hider

    const hiding = await startGame(master, roomId);
    await Promise.all([waitForActive(master), waitForActive(player)]);

    const seekerId = hiding.seekerId;
    const sockets = { [master.id]: master, [player.id]: player };
    const seekerSocket = sockets[seekerId];
    const hiderSocket = Object.values(sockets).find((s) => s.id !== seekerId);

    const [gameOverM, gameOverP] = await Promise.all([
      on(master, "game_over"),
      on(player, "game_over"),
      new Promise((r) => {
        seekerSocket.emit("tag", { roomId, targetId: hiderSocket.id });
        r();
      }),
    ]);

    expect(gameOverM.room.status).toBe("FINISHED");
    expect(gameOverP.room.status).toBe("FINISHED");
  });

  test("leaderboard is sorted by score descending", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1");

    const hiding = await startGame(master, roomId);
    await Promise.all([waitForActive(master), waitForActive(player)]);

    const seekerId = hiding.seekerId;
    const sockets = { [master.id]: master, [player.id]: player };
    const seekerSocket = sockets[seekerId];
    const hiderSocket = Object.values(sockets).find((s) => s.id !== seekerId);

    const gameOver = on(master, "game_over");
    seekerSocket.emit("tag", { roomId, targetId: hiderSocket.id });
    const data = await gameOver;

    const [first] = data.leaderboard;
    expect(first.id).toBe(seekerId);
    expect(first.score).toBe(10);
    expect(data.leaderboard[0].score).toBeGreaterThanOrEqual(data.leaderboard[1]?.score ?? 0);
  });
});

// ─── Master controls ──────────────────────────────────────────────────────────

describe("Master controls", () => {
  test("master can end game early", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1");
    await startGame(master, roomId);
    await Promise.all([waitForActive(master), waitForActive(player)]);

    const [gameOverM, gameOverP] = await Promise.all([
      on(master, "game_over"),
      on(player, "game_over"),
      new Promise((r) => { master.emit("end_game", { roomId }); r(); }),
    ]);

    expect(gameOverM.room.status).toBe("FINISHED");
    expect(gameOverP.room.status).toBe("FINISHED");
  });

  test("non-master cannot end game", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1");
    await startGame(master, roomId);
    await Promise.all([waitForActive(master), waitForActive(player)]);

    const p = on(player, "error");
    player.emit("end_game", { roomId });
    const err = await p;
    expect(err.message).toBe("Only the master can end the game");
  });

  test("master can reset game to LOBBY after it ends", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1");
    await startGame(master, roomId);
    await Promise.all([waitForActive(master), waitForActive(player)]);

    master.emit("end_game", { roomId });
    await on(master, "game_over");

    const [resetM, resetP] = await Promise.all([
      on(master, "game_reset"),
      on(player, "game_reset"),
      new Promise((r) => { master.emit("reset_game", { roomId }); r(); }),
    ]);

    expect(resetM.room.status).toBe("LOBBY");
    expect(resetP.room.status).toBe("LOBBY");
    resetM.room.players.forEach((p) => expect(p.status).toBe("safe"));
  });
});

// ─── REST endpoints ───────────────────────────────────────────────────────────

describe("REST endpoints", () => {
  const http = require("http");

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${port}${path}`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }).on("error", reject);
    });
  }

  test("GET / returns status ok", async () => {
    const { status, body } = await get("/");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  test("GET /rooms/:id returns room state", async () => {
    const { master, roomId } = await makeRoom("Alice");
    await on(master, "room_created").catch(() => {}); // already resolved; just ensure state exists

    const { status, body } = await get(`/rooms/${roomId}`);
    expect(status).toBe(200);
    expect(body.id).toBe(roomId);
    expect(body.status).toBe("LOBBY");
  });

  test("GET /rooms/:id returns 404 for unknown room", async () => {
    const { status, body } = await get("/rooms/XXXXXX");
    expect(status).toBe(404);
    expect(body.error).toBe("Room not found");
  });
});

// ─── Disconnect handling ──────────────────────────────────────────────────────

describe("Disconnect handling", () => {
  test("room is deleted when last player disconnects", async () => {
    const { master, roomId } = await makeRoom("Master");
    master.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    expect(rooms[roomId]).toBeUndefined();
  });

  test("player_left is emitted when a player disconnects", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Bob");

    const p = on(master, "player_left");
    player.disconnect();
    const data = await p;
    expect(data.playerName).toBe("Bob");
  });

  test("master role transfers when master disconnects", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1");

    const p = on(player, "player_left");
    master.disconnect();
    const data = await p;

    const room = rooms[roomId];
    expect(room.masterId).toBe(player.id);
    expect(room.players[player.id].role).toBe("master");
    expect(data.room.masterId).toBe(player.id);
  });

  test("game ends when seeker disconnects during ACTIVE phase", async () => {
    const { master, roomId } = await makeRoom("Master");
    const player = await joinRoom(roomId, "Player1");

    const hiding = await startGame(master, roomId);
    await Promise.all([waitForActive(master), waitForActive(player)]);

    const seekerId = hiding.seekerId;
    const sockets = { [master.id]: master, [player.id]: player };
    const seekerSocket = sockets[seekerId];
    const otherSocket = Object.values(sockets).find((s) => s.id !== seekerId);

    const p = on(otherSocket, "game_over");
    seekerSocket.disconnect();
    const data = await p;
    expect(data.room.status).toBe("FINISHED");
  });
});
