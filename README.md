# Hide & Seek — Acutis Lab

A real-world **Hide and Seek** companion app. Players join a shared room from their phones, a random seeker is chosen, a hiding countdown runs, and a live leaderboard updates as the seeker tags people.

The backend runs on [Render](https://render.com) and the frontend is hosted on GitHub Pages.

---

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│   GitHub Pages (frontend)   │        │     Render (backend)         │
│   index.html                │◄──────►│     index.js                 │
│   Tailwind CSS + Socket.IO  │  WSS   │     Express + Socket.IO      │
└─────────────────────────────┘        └──────────────────────────────┘
```

- **Frontend** — a single `index.html` page; no build step required.
- **Backend** — a Node.js server that manages rooms and broadcasts game events in real time.
- **Transport** — Socket.IO over WebSocket (falls back to polling).

---

## Game flow

```
LOBBY ──[master: start_game]──► HIDING ──[countdown ends]──► ACTIVE ──[all caught / end_game]──► FINISHED
  ▲                                                                                                    │
  └──────────────────────────────────────[master: reset_game]─────────────────────────────────────────┘
```

| State | Description |
|---|---|
| `LOBBY` | Players join using a 6-character room code. |
| `HIDING` | A seeker is chosen at random; a 20-second countdown lets hiders hide. |
| `ACTIVE` | The seeker tags players via the app; each tag awards 10 points. |
| `FINISHED` | Game over. The master can reset to `LOBBY` or everyone can leave. |

---

## What was built

### `index.js` — Backend (full rewrite)

The original server had a single global game state with no room support. It was completely rewritten with:

- **Room-based architecture** — multiple simultaneous games are supported. Each room has its own state, player list, and countdown timer.
- **`rooms` map + `socketToRoom` lookup** — O(1) room resolution on every event and on disconnect.
- **Configurable hide time** — `HIDE_TIME` environment variable (default `20` s). Set to `1` in tests so the countdown finishes instantly.
- **Automatic game-over** — triggered when the last hider is tagged.
- **Disconnect handling** — master role auto-transfers; game ends if the seeker disconnects mid-game; empty rooms are deleted.
- **CORS open to all origins** — required for GitHub Pages ↔ Render communication.
- **REST endpoints** — `GET /` (health check) and `GET /rooms/:id` (room state snapshot).
- **Module exports** — `app`, `server`, `io`, `rooms`, `socketToRoom` are exported so the test suite can control the server lifecycle without a real port.

**Socket events handled:**

| Client → Server | Description |
|---|---|
| `create_room` | Creates a room; caller becomes master. |
| `join_room` | Joins an existing room (LOBBY only). |
| `start_game` | Master picks a random seeker and starts the hiding countdown. |
| `tag` | Seeker marks a hider as caught (+10 pts). |
| `end_game` | Master ends the game immediately. |
| `reset_game` | Master resets a finished game back to LOBBY. |

---

### `test/game.test.js` — Jest test suite (new file)

29 tests covering the full game lifecycle using real Socket.IO connections against a locally started server instance.

| Suite | Tests |
|---|---|
| Room management | create room, join room, case-insensitive code, unknown room, game-in-progress rejection, empty name validation |
| Game start | solo player rejection, non-master rejection, double-start rejection, hiding_started broadcast, seeker/hider status assignment |
| Countdown & ACTIVE | countdown ticks, transition to ACTIVE on both sockets |
| Tagging | non-seeker rejection, successful tag (+10 pts, status=caught), double-tag rejection, tag outside ACTIVE, auto game_over, leaderboard sort |
| Master controls | early end_game, non-master end rejection, reset_game back to LOBBY |
| REST endpoints | GET / health, GET /rooms/:id success and 404 |
| Disconnect handling | empty room deletion, player_left broadcast, master role transfer, game_over when seeker disconnects |

Run the suite with:

```bash
npm test
```

---

### `index.html` — Frontend (new file)

A single-page companion app hosted on GitHub Pages. Built with **Tailwind CSS** (CDN) and the **Socket.IO client** loaded directly from the Render backend.

**Five screens:**

| Screen | Who sees it | What it does |
|---|---|---|
| **Home** | Everyone | Enter name, create a room or join by code. |
| **Lobby** | Everyone | Shows room code (tap to copy), live player list. Master sees **Start Game** button. |
| **Hiding countdown** | Everyone | Seeker sees 🔍 "YOU ARE THE SEEKER!"; hiders see 🏃 "HIDE NOW!" with the seeker's name. Pulsing circular timer counts down. |
| **Active game** | Everyone | **Seeker**: player list with red **Tag!** buttons, caught players greyed out. **Hider**: status card (green = safe, red = caught) + live leaderboard. Master sees **End Game Early** button. |
| **Game over** | Everyone | Final leaderboard with 🥇🥈🥉 medals. Master sees **Play Again**; everyone sees **Leave Room**. |

**Other details:**
- Toast notifications for errors, player join/leave, and tag events.
- Loading overlay with a "first wake-up may take ~30 s" note for Render's free-tier cold starts.
- Room code input auto-uppercases. Enter key submits forms.
- XSS-safe rendering (all user strings HTML-escaped before insertion).

---

### `API.md` — API reference (new file)

Full documentation of all Socket.IO events and REST endpoints, including payload shapes, the room state object, the player object, the game state machine diagram, all possible error messages, and environment variables.

---

## Running locally

**Backend:**
```bash
npm install
npm start          # listens on PORT env var or 3000
```

**Tests:**
```bash
npm test
```

**Frontend (local network preview):**
```bash
node serve-local.js
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port for the backend server. |
| `HIDE_TIME` | `20` | Hiding countdown duration in seconds. |

---

## Deployment

| Service | What to deploy | How |
|---|---|---|
| **Render** | `index.js` | Connect the repo; set start command to `npm start`. |
| **GitHub Pages** | `index.html` | Settings → Pages → Deploy from branch `main`, folder `/`. |
