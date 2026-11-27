# Realism Roleplay — Multiplayer Framework (Supabase)

Design for adding online multiplayer, a server browser, and character creation
to Realism Roleplay, using **Supabase** as the backend for server registry,
presence, and real-time player sync.

---

## 1. Goals

1. **Online** option on the start screen → opens a **server browser**.
2. Server browser lists **public joinable servers** with **name**, **player count**,
   max players, and a **Join** button.
3. **3 default public servers** seeded in the database.
4. Players can **create public servers** (free join) and **private servers**
   (join only with the owner's code).
5. **Character creation** for **both** Free Roam (offline) and Online:
   **name** + **skin color**.
6. Real-time sync of remote players inside a server (position, rotation, motion).

## 2. Why Supabase

Supabase gives us, in one free tier:

| Need | Supabase feature |
| --- | --- |
| Server registry (list of servers, codes, owner) | Postgres table `servers` |
| Who is online / player counts | Postgres table `server_sessions` + Realtime **Presence** |
| High-frequency player transform sync | Realtime **Broadcast** (ephemeral, no DB writes) |
| Join/leave events | Realtime **Presence** diffs |
| Authenticated ownership later | Supabase Auth (optional, MVP uses anon) |

Crucially, **Broadcast** sends position updates peer-to-peer through Supabase's
Realtime edge network **without writing to the database** — exactly right for
20 Hz transform data. The database only stores the slow-changing registry and
session heartbeats.

## 3. Data model

```sql
servers
  id            uuid PK
  name          text
  is_public     boolean        -- true = shows in browser; false = join by code only
  join_code     text           -- 6-char code, required for private servers
  owner_id      uuid           -- client-side player id of the creator
  max_players   int            -- default 16
  seed          int            -- map seed (reserved; MVP uses one shared map)
  created_at    timestamptz

server_sessions
  id            uuid PK        -- = player_id (one row per player per server)
  server_id     uuid FK -> servers
  player_id     uuid           -- client-side identity (stored in localStorage)
  player_name   text
  skin_color    text           -- hex, e.g. "#c68642"
  last_seen     timestamptz    -- heartbeat; sessions older than 30s are "offline"
  joined_at     timestamptz
```

**Player count** for a server = number of `server_sessions` rows for that server
with `last_seen > now() - 30 seconds`. This is computed on read (a subquery),
so it is always correct and never races. Stale sessions are ignored, not deleted
on read; a reaper deletes them periodically.

Three default servers are inserted with `ON CONFLICT DO NOTHING` so re-running
the migration is safe.

### Row Level Security (MVP)

MVP uses the **anon key** (no Supabase Auth) so the game works immediately.
RLS policies are permissive on these two tables for the `anon` role. The
schema file includes a clearly-marked section explaining how to tighten this
once Supabase Auth is added (owner-scoped deletes, per-player session rows, etc.).

## 4. Realtime channels

When a player joins server `S`, the client joins **one** Supabase Realtime
channel: `server:<server_id>`. That channel carries three things:

| Feature | Use |
| --- | --- |
| **Presence** | online roster: `{ id, name, skinColor }`. Drives avatar spawn/remove and the live player count. |
| **Broadcast** `move` | player transforms and driven-vehicle pose, sent at up to 20 Hz. Ephemeral. |
| **Broadcast** `shot` | weapon hit rays, checked against each receiver's local player and world collision. Ephemeral. |
| **Broadcast** `death` | elimination notices for the in-session kill/death HUD. Ephemeral. |

No Postgres Changes subscription is needed for transforms — Broadcast is far
cheaper. The servers list is refreshed by polling the `servers` table every 5 s
while the browser is open.

## 5. Client identity

Each browser gets a persistent identity in `localStorage`:

- `rrmp_player_id` — a generated UUID (created once).
- `rrmp_character` — `{ name, skinColor }` chosen in the character creator.

No password / login in MVP. When Supabase Auth is added later, `player_id`
becomes the auth user id and the same code paths keep working.

## 6. File map (what goes where in the repo)

```
RealismRoleplay-web-official-/
├── index.html                       # MODIFIED — adds 3 script tags + exposes world global
├── supabase-config.js               # NEW — runtime config (URL + anon key), like realism-config.js
├── realism-multiplayer.js           # NEW — the framework (runtime, no rebuild needed)
├── supabase/
│   └── schema.sql                   # NEW — tables, 3 default servers, RLS, reaper function
├── MULTIPLAYER_SETUP.md             # NEW — step-by-step setup
└── ARCHITECTURE.md                  # NEW — this file
```

The framework is **runtime JavaScript** loaded after the built bundle, exactly
like the project's existing `realism-config.js`. **No webpack rebuild is
required** to go live. (A TypeScript port into `src/ts/multiplayer/` is
described in §10 for teams who want it compiled into the bundle later.)

## 7. Module structure of `realism-multiplayer.js`

```
window.RRMP
├── config        // reads window.SUPABASE_CONFIG, validates it
├── db            // supabase client + query helpers (list/join/create/leave servers)
├── identity      // player_id + character (name, skinColor) from localStorage
├── ui
│   ├── injectStartButtons()   // adds Online + Character buttons to .rr-menu
│   ├── serversModal           // browser: list, refresh, join, create, join-by-code
│   ├── createServerModal
│   ├── joinByCodeModal
│   ├── characterModal         // name input + skin color picker/presets
│   └── statusHud              // "Server: X • N online" + Leave button
├── session       // joinServer / leaveServer, presence, 5s heartbeat, unload cleanup
├── sync          // 20 Hz broadcast of local transform, receive loop, lerp targets
├── avatars       // spawn/update/remove remote player meshes + floating name tags
├── skin          // apply skinColor to local player's boxman materials (clone-safe)
└── bootstrap     // wait for Sketchbook.World + .rr-menu, wire everything, re-apply skin on respawn
```

## 8. Integration points with the existing engine

| Engine hook | How we use it |
| --- | --- |
| `new Sketchbook.World('realism')` in `index.html` | Exposed as `window.realismWorld` so RRMP can read it. |
| `world.realismUI` (RealismUI) | We inject buttons into its `.rr-menu`. We call `world.realismUI.play()` to start the game after joining a server (same path as Free Roam). |
| `world.realismUI.setBlocking(owner, on)` | Our modals register as a UI-blocking owner `'multiplayer'` so gameplay input is ignored while a modal is open. |
| `world.characters[0]` | The local player. We read its capsule body position + model yaw for broadcast, and tint its materials for skin color. |
| `world.graphicsWorld` (THREE.Scene) | We add remote avatar groups here. |
| `window.THREE` | Already loaded by the bundle; reused for avatar geometry. |

### Remote avatars (MVP)

Each remote player is a lightweight `THREE.Group` (capsule body + sphere head,
tinted to their skin color) with a floating name sprite — **not** a full physics
`Character`. This avoids physics conflicts and keeps it cheap. Position/rotation
are lerped toward the latest received transform each frame. The motion value
(idle/walk/run) bobs the avatar so movement is readable. Upgrading to a full
skinned boxman per remote player is a documented follow-up (§10).

### Skin color on the local player

The boxman's materials are traversed and **cloned** before tinting, so NPC
boxmen (which may share the same material) are unaffected. The chosen color is
re-applied whenever the local character changes (e.g. after Shift+R respawn).

## 9. Flows

### Free Roam (offline)
1. Start screen → **Character** → pick name + skin → saved to localStorage.
2. **Play (Free Roam)** → `world.realismUI.play()`. Skin applied to player. No network.

### Online
1. Start screen → **Character** → pick name + skin.
2. **Online** → servers modal opens → list loads from Supabase.
3. Click **Join** on a public server (or **Join by Code** for private) →
   `joinServer()` inserts/refreshes a `server_sessions` row, joins the
   `server:<id>` Realtime channel, starts presence + broadcast, then calls
   `world.realismUI.play()`.
4. The game starts after connecting. Remote players appear as avatars; their
   transforms and driven vehicles update in real time. Weapon hits reduce
   player health and trigger a delayed respawn on elimination.
5. **Leave** (status HUD) or close tab → session row deleted (best-effort
   `sendBeacon`), channel unsubscribed, avatars removed.

### Create server
1. Servers modal → **Create Server** → name, public/private, code (if private), max players.
2. Inserts a `servers` row, then joins it as the owner.

## 10. Follow-ups (out of MVP scope, documented for later)

- Supabase Auth + tightened RLS (owner-scoped server delete, per-player sessions).
- Per-server map seed → world rebuild on join (currently all servers share seed 1337).
- Full skinned boxman avatars with animation states instead of capsule proxies.
- Server chat, voice, kick/ban, friends list, persistent inventory sync.
- TypeScript port into `src/ts/multiplayer/` compiled by the existing webpack config.
- Interest management / culling for >16 players (only sync nearby avatars).
```
