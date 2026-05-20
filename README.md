# Hide & Seek — Acutis Lab

A real-world **Hide and Seek** companion app. Players join a shared room from their phones, a random seeker is chosen, and the game progresses through configurable **day/night turns** with a doctor role, personal codes, and a wounded/healing mechanic.

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
LOBBY ──[master: start_game]──► NIGHT ──[countdown ends]──► DAY ──[countdown ends]──► NIGHT (next turn)
  ▲                                                                                          │
  │                      (repeats for totalTurns cycles)                                    │
  │                                                                                          ▼
  └─────────────────────────────────[master: reset_game]────────────────────────────── FINISHED
```

| State | Description |
|---|---|
| `LOBBY` | Players join using a 6-character room code. |
| `NIGHT` | Active hunting phase (~8 min). Seekers tag survivors by code; doctors can heal the wounded. |
| `DAY` | Rest phase (~1 min). Seekers cannot tag. Players converted overnight are announced. |
| `FINISHED` | Game over. The master can reset to `LOBBY`. |

### Roles

| Role | Description |
|---|---|
| **Survivor** | Hides from seekers. Has a personal code. |
| **Doctor** | A survivor secretly assigned each night. Can heal one wounded player per night. Changes every night. |
| **Wounded** | A survivor who was tagged. Must be healed before the night ends or will be converted. |
| **Seeker** | Hunts survivors. Grows as survivors are converted. |

### Victory conditions

| Winner | Condition |
|---|---|
| **Survivors** | At least one survivor is alive when all turns end. |
| **Seekers** | All survivors are converted before the turns end. |

---

## What was built

### `index.js` — Backend

The server manages rooms and broadcasts game events in real time. Key features:

- **Room-based architecture** — multiple simultaneous games supported. Each room has its own state, player list, and timers.
- **Turn system** — the master sets `totalTurns` at game start. Each turn = one Night + one Day.
- **Personal codes** — each survivor gets a unique 6-character code at game start, sent privately. Codes are never included in the public room state.
- **Tag by code** — seekers submit a survivor's code to wound them (not immediate conversion).
- **Heal by code** — doctors submit a wounded player's code to save them. The healed player receives a fresh code automatically to prevent reuse.
- **Doctor assignment** — at the start of every night, doctors are randomly picked from alive survivors: `floor(survivors × 10%)`, minimum 1 if ≥ 10 survivors, 0 if fewer.
- **Conversion** — at the end of each night, wounded players who were not healed become seekers and are announced at the next day start.
- **Disconnect handling** — master role auto-transfers; empty rooms are deleted; reconnecting players within the grace period recover their code and role.
- **CORS open to all origins** — required for GitHub Pages ↔ Render communication.
- **REST endpoints** — `GET /` (health check) and `GET /rooms/:id` (room state snapshot).

**Socket events — client → server:**

| Event | Description |
|---|---|
| `create_room` | Creates a room; caller becomes master. |
| `join_room` | Joins an existing room (LOBBY only). |
| `start_game` | Master sets `totalTurns`, assigns codes, picks first seeker, starts Night 1. |
| `tag` | Seeker submits a survivor's `targetCode`; survivor becomes `wounded` (+10 pts). |
| `heal` | Doctor submits a wounded player's `targetCode`; player is saved and gets a new code (+5 pts). |
| `end_game` | Master ends the game immediately. |
| `reset_game` | Master resets a finished game back to LOBBY. |

---

### `test/game.test.js` — Jest test suite

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

### `index.html` — Frontend

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

### `docs/` — Documentation

| File | Description |
|---|---|
| `docs/API.md` | Full reference for all Socket.IO events and REST endpoints: payload shapes, room state object, player object, game state machine, all error messages, and environment variables. |
| `docs/REGOLE_NASCONDINO.md` | Complete game rules document (in Italian): roles, phases, tagging/healing mechanics, doctor assignment formula, and victory conditions. |

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
| `DAY_TIME` | `60` | Day phase duration in seconds. |
| `NIGHT_TIME` | `480` | Night phase duration in seconds. |

---

## Deployment

| Service | What to deploy | How |
|---|---|---|
| **Render** | `index.js` | Connect the repo; set start command to `npm start`. |
| **GitHub Pages** | `index.html` | Settings → Pages → Deploy from branch `main`, folder `/`. |
