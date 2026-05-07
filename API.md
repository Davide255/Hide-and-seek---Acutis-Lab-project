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

## Game states

```
LOBBY ──start_game──► HIDING ──countdown ends──► ACTIVE ──all caught / end_game──► FINISHED
  ▲                                                                                     │
  └────────────────────────────reset_game──────────────────────────────────────────────┘
```

| State | Description |
|---|---|
| `LOBBY` | Players are joining. Only the master can start the game. |
| `HIDING` | A seeker has been chosen. Countdown runs; hiders hide. |
| `ACTIVE` | Countdown expired. Seeker can now tag players. |
| `FINISHED` | Game over. Master can reset to `LOBBY`. |

---

## Data shapes

### Player object
```json
{
  "id": "<socket-id>",
  "name": "Alice",
  "role": "master | player",
  "status": "safe | hiding | seeking | caught",
  "score": 10
}
```

### Room state object
```json
{
  "id": "AB12CD",
  "status": "LOBBY | HIDING | ACTIVE | FINISHED",
  "masterId": "<socket-id>",
  "seekerId": "<socket-id> | null",
  "players": [ /* Player objects */ ],
  "leaderboard": [ /* Player objects sorted by score desc */ ],
  "hideTimeRemaining": 14
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
*(Master only)* Randomly selects a seeker and starts the hiding countdown.

**Payload**
```json
{ "roomId": "AB12CD" }
```

**Broadcasts to room:** [`hiding_started`](#hiding_started), then [`countdown`](#countdown) every second, then [`game_active`](#game_active)  
**Emits on error:** [`error`](#error)

---

### `tag`
*(Seeker only, `ACTIVE` phase)* Marks a hiding player as caught and awards +10 points to the seeker. Triggers [`game_over`](#game_over) automatically if every hider is caught.

**Payload**
```json
{ "roomId": "AB12CD", "targetId": "<target-socket-id>" }
```

**Broadcasts to room:** [`player_tagged`](#player_tagged), and [`game_over`](#game_over) when all hiders are caught  
**Emits on error:** [`error`](#error)

---

### `end_game`
*(Master only)* Ends the game immediately from any active state.

**Payload**
```json
{ "roomId": "AB12CD" }
```

**Broadcasts to room:** [`game_over`](#game_over)  
**Emits on error:** [`error`](#error)

---

### `reset_game`
*(Master only)* Resets a `FINISHED` game back to `LOBBY`. Player scores are preserved.

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
Broadcast to all **other** players in the room when someone new joins.

```json
{
  "player": { /* Player object */ },
  "room":   { /* Room state object */ }
}
```

---

### `hiding_started`
Broadcast to all players when the master starts the game. Signals the beginning of the hiding countdown.

```json
{
  "seekerId": "<socket-id>",
  "hideTime": 20,
  "room":     { /* Room state object, status = HIDING */ }
}
```

---

### `countdown`
Broadcast to all players once per second during the `HIDING` phase.

```json
{ "timeRemaining": 14 }
```

---

### `game_active`
Broadcast to all players when the countdown reaches zero. The seeker may now tag players.

```json
{
  "room": { /* Room state object, status = ACTIVE */ }
}
```

---

### `player_tagged`
Broadcast to all players when the seeker tags a hider.

```json
{
  "targetId":   "<socket-id>",
  "targetName": "Bob",
  "room":       { /* Room state object with updated scores */ }
}
```

---

### `game_over`
Broadcast to all players when the game ends (all hiders caught, master calls `end_game`, or seeker disconnects).

```json
{
  "room":        { /* Room state object, status = FINISHED */ },
  "leaderboard": [ /* Player objects sorted by score desc */ ]
}
```

---

### `game_reset`
Broadcast to all players when the master resets the game to `LOBBY`.

```json
{
  "room": { /* Room state object, status = LOBBY */ }
}
```

---

### `player_left`
Broadcast to all remaining players when someone disconnects.

```json
{
  "playerId":   "<socket-id>",
  "playerName": "Bob",
  "room":       { /* Room state object */ }
}
```

> **Note:** If the disconnecting player was the **master**, the role is automatically transferred to the next available player (reflected in `room.masterId`). If the disconnecting player was the **seeker** during an active game, `game_over` is emitted instead.

---

### `error`
Sent only to the client that triggered an invalid action.

```json
{ "message": "Only the seeker can tag players" }
```

| Message | Cause |
|---|---|
| `Name is required` | Empty or missing `name` field |
| `Room not found` | Unknown `roomId` |
| `Game already in progress` | `join_room` or `start_game` on a non-LOBBY room |
| `Need at least 2 players to start` | `start_game` with fewer than 2 players |
| `Only the master can start the game` | Non-master calls `start_game` |
| `Only the master can end the game` | Non-master calls `end_game` |
| `Only the master can reset the game` | Non-master calls `reset_game` |
| `Game is not active` | `tag` called outside `ACTIVE` phase |
| `Only the seeker can tag players` | Non-seeker calls `tag` |
| `Player not found` | Unknown `targetId` in `tag` |
| `Player is already caught` | `tag` on a player with `status = caught` |

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the server listens on |
| `HIDE_TIME` | `20` | Hiding countdown duration in seconds |
