# Hide and Seek — API Reference

The server exposes a **Socket.IO** interface for real-time game events and a small **REST** interface for status checks.

---

## Connection

```
wss://<your-render-host>        (Socket.IO WebSocket)
https://<your-render-host>      (REST)
```

Socket.IO CORS is open to all origins (`*`), so any GitHub Pages client can connect.

---

## Game Flow

```
LOBBY ──start_game──► NIGHT ──countdown ends──► DAY ──countdown ends──► NIGHT (next turn)
  ▲                                                                          |
  |           (repeats for totalTurns cycles)                                |
  |                                                                           ▼
  └────────────────────reset_game─────────────────────────── FINISHED
```

The game is structured in **turns**, each consisting of one **Night** phase followed by one **Day** phase.

| State | Description |
|---|---|
| `LOBBY` | Players are joining. Only the master can start the game. |
| `NIGHT` | Active hunting phase (~8 min). Seekers tag survivors by code; doctors heal the wounded. |
| `DAY` | Rest phase (~1 min). Seekers cannot tag. Converted players from the previous night are announced. |
| `FINISHED` | Game over. Master can reset to `LOBBY`. |

### Victory conditions

| Winner | Condition |
|---|---|
| **Survivors** | At least one survivor is alive when all turns end. |
| **Seekers** | All survivors are converted before the turns end. |

---

## Data shapes

### Player object *(codes are never included in room state)*

```json
{
  "id": "<socket-id>",
  "name": "Alice",
  "role": "master | player",
  "status": "survivor | doctor | wounded | seeker",
  "score": 10
}
```

| Status | Description |
|---|---|
| `survivor` | Alive, hiding normally. |
| `doctor` | Alive survivor with the doctor role for this night. Changes every night. |
| `wounded` | Tagged by a seeker this night. Must be healed before the night ends or will be converted. |
| `seeker` | Hunting survivors. Cannot be tagged. |

### Room state object

```json
{
  "id": "AB12CD",
  "status": "LOBBY | NIGHT | DAY | FINISHED",
  "masterId": "<socket-id>",
  "totalTurns": 5,
  "currentTurn": 2,
  "players": [ /* Player objects — no codes */ ],
  "leaderboard": [ /* Player objects sorted by score desc */ ],
  "phaseTimeRemaining": 347
}
```

---

## REST endpoints

### `GET /`

Health check.

**Response `200`**
```json
{ "status": "ok", "activeRooms": 3 }
```

---

### `GET /rooms/:roomId`

Returns the current state of a room. Room IDs are case-insensitive.

**Response `200`** — Room state object (see above).

**Response `404`**
```json
{ "error": "Room not found" }
```

---

## Socket.IO — client → server

All events carry a single JSON payload object.

---

### `create_room`

Creates a new room. The caller becomes the **master** and is automatically joined.

**Payload**
```json
{ "name": "Alice" }
```

**Emits back:** [`room_created`](#room_created)  
**Emits on error:** [`error`](#error)

---

### `join_room`

Joins an existing room. Only allowed while the room is in `LOBBY`.

**Payload**
```json
{ "roomId": "AB12CD", "name": "Bob" }
```

**Emits back:** [`room_joined`](#room_joined)  
**Broadcasts to room:** [`player_joined`](#player_joined)  
**Emits on error:** [`error`](#error)

---

### `start_game`

*(Master only)* Assigns unique codes to all players, randomly selects the first seeker, and starts turn 1.

**Payload**
```json
{ "roomId": "AB12CD", "totalTurns": 5 }
```

| Field | Type | Description |
|---|---|---|
| `totalTurns` | `number` | Number of day+night cycles. Must be ≥ 1. |

**Sequence of emits:**
1. [`game_started`](#game_started) — broadcast
2. [`your_code`](#your_code) — private, to each survivor
3. [`night_started`](#night_started) — broadcast
4. [`doctor_assigned`](#doctor_assigned) — private, to each doctor

**Emits on error:** [`error`](#error)

---

### `tag`

*(Seekers only, `NIGHT` phase)* Tags a survivor using their personal code. The survivor enters the `wounded` state. A wounded player cannot be tagged again and has until the end of the night to be healed.

**Payload**
```json
{ "roomId": "AB12CD", "targetCode": "XYZ789" }
```

**Broadcasts to room:** [`player_wounded`](#player_wounded)  
**Emits on error:** [`error`](#error)

---

### `heal`

*(Doctors only, `NIGHT` phase)* Heals a wounded player using their personal code. The player returns to `survivor` and receives a new code automatically.

**Payload**
```json
{ "roomId": "AB12CD", "targetCode": "XYZ789" }
```

**Broadcasts to room:** [`player_healed`](#player_healed)  
**Emits privately to healed player:** [`your_code`](#your_code) (new code)  
**Emits on error:** [`error`](#error)

---

### `end_game`

*(Master only)* Ends the game immediately.

**Payload**
```json
{ "roomId": "AB12CD" }
```

**Broadcasts to room:** [`game_over`](#game_over)  
**Emits on error:** [`error`](#error)

---

### `reset_game`

*(Master only)* Resets a finished game back to `LOBBY`. Player scores are preserved.

**Payload**
```json
{ "roomId": "AB12CD" }
```

**Broadcasts to room:** [`game_reset`](#game_reset)  
**Emits on error:** [`error`](#error)

---

## Socket.IO — server → client

---

### `room_created`

Sent only to the master after a room is created.

```json
{
  "roomId": "AB12CD",
  "player": { /* Player object */ },
  "room":   { /* Room state object */ }
}
```

---

### `room_joined`

Sent only to the joining player on success.

```json
{
  "player": { /* Player object */ },
  "room":   { /* Room state object */ }
}
```

---

### `player_joined`

Broadcast to all **other** players when someone new joins.

```json
{
  "player": { /* Player object */ },
  "room":   { /* Room state object */ }
}
```

---

### `game_started`

Broadcast to all players when the master starts the game.

```json
{
  "seekerId":   "<socket-id>",
  "totalTurns": 5,
  "room":       { /* Room state object */ }
}
```

---

### `your_code`

Sent **privately** to a player when they receive or are assigned a new personal code. Codes are never included in the room state.

```json
{ "code": "XYZ789" }
```

Triggered by:
- Game start (to each survivor)
- After being healed (new code replaces the old one to prevent reuse)
- After rejoining a game in progress

---

### `night_started`

Broadcast when a night phase begins.

```json
{
  "turn":       2,
  "totalTurns": 5,
  "nightTime":  480,
  "room":       { /* Room state object, status = NIGHT */ }
}
```

---

### `doctor_assigned`

Sent **privately** to each player who has been assigned the doctor role for this night.

```json
{ "yourCode": "XYZ789" }
```

> Doctors are reassigned randomly at the start of every night. Only the assigned player knows they are a doctor.

---

### `countdown`

Broadcast once per second during both `NIGHT` and `DAY` phases.

```json
{ "phase": "NIGHT | DAY", "timeRemaining": 347 }
```

---

### `player_wounded`

Broadcast when a seeker successfully tags a survivor.

```json
{
  "targetId":   "<socket-id>",
  "targetName": "Bob",
  "room":       { /* Room state object */ }
}
```

---

### `player_healed`

Broadcast when a doctor successfully heals a wounded player.

```json
{
  "targetId":   "<socket-id>",
  "targetName": "Bob",
  "room":       { /* Room state object */ }
}
```

---

### `day_started`

Broadcast when a day phase begins. Includes the list of players converted during the preceding night.

```json
{
  "turn":             2,
  "totalTurns":       5,
  "convertedPlayers": [ { "id": "<socket-id>", "name": "Bob" } ],
  "dayTime":          60,
  "room":             { /* Room state object, status = DAY */ }
}
```

> `convertedPlayers` lists survivors who were wounded during the previous night and not healed in time. They are now seekers.

---

### `game_over`

Broadcast when the game ends.

```json
{
  "winner":      "survivors | seekers",
  "reason":      "turns_ended | all_converted | master_ended",
  "room":        { /* Room state object, status = FINISHED */ },
  "leaderboard": [ /* Player objects sorted by score desc */ ]
}
```

| `reason` | Cause |
|---|---|
| `turns_ended` | All turns completed; at least one survivor remained. |
| `all_converted` | Every survivor was converted. |
| `master_ended` | Master forcefully ended the game. |

---

### `game_reset`

Broadcast when the master resets the game to `LOBBY`.

```json
{
  "room": { /* Room state object, status = LOBBY */ }
}
```

---

### `player_left`

Broadcast when a player permanently disconnects (after the reconnect grace period).

```json
{
  "playerId":   "<socket-id>",
  "playerName": "Bob",
  "room":       { /* Room state object */ }
}
```

> If the disconnecting player was the **master**, the role is automatically transferred to the next available player (reflected in `room.masterId`).

---

### `room_rejoined`

Sent to a player who successfully reconnects within the grace period.

```json
{
  "room":     { /* Room state object */ },
  "isMaster": false,
  "isDoctor": true
}
```

---

### `player_rejoined`

Broadcast to all other players when someone reconnects.

```json
{
  "playerName": "Bob",
  "room":       { /* Room state object */ }
}
```

---

### `error`

Sent only to the client that triggered an invalid action.

```json
{ "message": "Only seekers can tag players" }
```

| Message | Cause |
|---|---|
| `Name is required` | Empty or missing `name` field |
| `Room not found` | Unknown `roomId` |
| `Game already in progress` | `join_room` or `start_game` on a non-LOBBY room |
| `Need at least 2 players to start` | `start_game` with fewer than 2 players |
| `totalTurns must be a positive integer` | Missing or invalid `totalTurns` in `start_game` |
| `Only the master can start the game` | Non-master calls `start_game` |
| `Only the master can end the game` | Non-master calls `end_game` |
| `Only the master can reset the game` | Non-master calls `reset_game` |
| `Can only tag during night phase` | `tag` called outside `NIGHT` phase |
| `Only seekers can tag players` | Non-seeker calls `tag` |
| `Target code is required` | Missing `targetCode` in `tag` or `heal` |
| `Invalid code` | No active player has the given code |
| `Player cannot be tagged` | Target is already `wounded` or is a `seeker` |
| `Can only heal during night phase` | `heal` called outside `NIGHT` phase |
| `Only doctors can heal` | Non-doctor calls `heal` |
| `Doctors cannot heal themselves` | Doctor submits their own code |
| `Player is not wounded` | Target is not in `wounded` state |
| `Game in progress, cannot rejoin` | `rejoin_room` with no pending disconnected slot |

---

## Scoring

| Action | Points |
|---|---|
| Seeker tags a survivor | +10 |
| Doctor heals a wounded player | +5 |

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the server listens on |
| `DAY_TIME` | `60` | Day phase duration in seconds |
| `NIGHT_TIME` | `480` | Night phase duration in seconds |
