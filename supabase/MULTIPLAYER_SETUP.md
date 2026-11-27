# Realism Roleplay — Multiplayer Setup Guide

This adds **online multiplayer** (Supabase), a **server browser** with 3 default
servers, **public/private server creation** (with join codes), and a
**character creator** (name + skin color) for both Free Roam and Online.

No webpack rebuild is required — the framework loads at runtime, the same way
`realism-config.js` already does.

---

## What you're adding

| File | Goes in your repo at | Purpose |
| --- | --- | --- |
| `index.html` | `index.html` (replace) | Loads the new scripts and exposes the world |
| `supabase-config.js` | `supabase-config.js` | Your Supabase URL + anon key |
| `realism-multiplayer.js` | `realism-multiplayer.js` | The multiplayer framework |
| `supabase/schema.sql` | `supabase/schema.sql` | Database tables, 3 default servers, RLS |
| `ARCHITECTURE.md` | `ARCHITECTURE.md` | Design reference |
| `MULTIPLAYER_SETUP.md` | `MULTIPLAYER_SETUP.md` | This file |

---

## Step 1 — Create a Supabase project (free)

1. Go to <https://supabase.com> and sign in.
2. **New project** → pick a name (e.g. `realism-roleplay`), a strong database
   password, and a region close to your players.
3. Wait ~2 minutes for it to provision.

## Step 2 — Run the database schema

1. In your Supabase dashboard open **SQL Editor → New query**.
2. Open `supabase/schema.sql`, copy the **entire** file, paste it into the
   editor, and click **Run**.
3. You should see "Success". This creates the `servers` and `server_sessions`
   tables, inserts the **3 default servers** (Downtown / Westside / Northside),
   enables Realtime, and sets permissive RLS policies for the anon key.

You can re-run it any time — it's idempotent.

## Step 3 — Paste your keys into `supabase-config.js`

1. Dashboard → **Project Settings → API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `supabase-config.js` and fill them in:

   ```js
   window.SUPABASE_CONFIG = {
       url: 'https://abcdxxxx.supabase.co',
       anonKey: 'eyJhbGciOi...your-anon-key...',
       multiplayer: { /* defaults are fine */ }
   };
   ```

The anon key is **safe to ship in a browser** — it's gated by Row Level
Security, not by secrecy. Never put the `service_role` key in the browser.

## Step 4 — Drop the files into your repo

Copy these into the **root** of your repo (next to `index.html` and
`realism-config.js`):

- `index.html` (replaces the existing one)
- `supabase-config.js`
- `realism-multiplayer.js`
- `supabase/schema.sql` (for reference / version control)

Then push to `main` (or your GitHub Pages branch). If you host on GitHub Pages,
jsDelivr, or any static host, it works as-is — the Supabase client loads from
the jsDelivr CDN.

## Step 5 — Test it

1. Open the game. The start screen now shows **Play**, **Online**, **Character**,
   **Settings**, **Controls**.
2. Click **Character** → enter a name and pick a skin color → **Save**. (Works
   for Free Roam too — the boxman recolors.)
3. Click **Online** → you'll see the 3 default servers with `0 / 24` players →
   **Join** one.
4. Open the game in a **second browser tab** (or a different device / browser)
   and join the same server. Joining starts the game; you should see each other
   as avatars with floating name tags, moving in real time.
5. Players can damage each other with weapon slots (including fists). Health,
   kills, and deaths appear in the online HUD; eliminated players respawn after
   a short delay.
6. Players seated in the same spawned vehicle see its synchronized position
   and each other riding in it. A shared vehicle proxy is shown if there is no
   matching local vehicle.
7. The top-center HUD shows the server name and online count; **Leave** exits.
8. Try **Create Server** (public or private with a code) and **Join by Code**.

Open the browser console (F12) and filter for `[RRMP]` to see join/leave/sync
logs. Set `multiplayer.verbose: true` in `supabase-config.js` for more detail.

---

## How it works (30-second version)

- **Server registry** = `servers` table in Supabase (the 3 defaults are seeded).
- **Player count** = live count of `server_sessions` rows with a heartbeat in
  the last 30 seconds (computed by the `list_servers()` SQL function).
- **Real-time sync** = Supabase Realtime: **Presence** tracks who's online,
  **Broadcast** streams player and driven-vehicle transforms at up to 20 Hz,
  and relays weapon hit rays without touching the database.
- **Identity** = a UUID + your chosen name/skin, stored in `localStorage`.
  No login required for the MVP.
- **Remote players** = lightweight tinted capsule + head + name tag, lerped to
  the latest received position each frame.

Full design in `ARCHITECTURE.md`.

---

## Tightening security (when you add Supabase Auth)

The MVP uses the anon key with permissive RLS so it works with zero setup. When
you're ready to lock things down:

1. Enable **Supabase Auth** (email/password, magic link, or OAuth).
2. Replace the permissive policies in `schema.sql` with owner-scoped ones, e.g.:

   ```sql
   create policy "servers_delete_owner" on public.servers
     for delete using (owner_id = auth.uid());
   create policy "sessions_self" on public.server_sessions
     for all using (player_id = auth.uid()) with check (player_id = auth.uid());
   ```

3. In `realism-multiplayer.js`, swap `identity.id` (the localStorage UUID) for
   the auth user's id after sign-in. The rest of the code stays the same.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Start screen shows **Online** disabled / "Multiplayer is not configured" | `supabase-config.js` still has the placeholder values — paste your real URL + anon key. |
| "Could not load servers" in the browser | You didn't run `schema.sql`, or RLS is blocking. Re-run the SQL; check the Supabase logs. |
| Player count stays at 0 / doesn't update | Heartbeats use `server_sessions.last_seen`. Make sure your clock is fine and the `reap_stale_sessions()` function exists. Counts refresh every 5 s. |
| You can't see other players | Both tabs must join the **same server**. Check the console for `[RRMP] presence tracked`. If you see `CHANNEL_ERROR`, the Supabase project's Realtime may be paused on the free tier (it wakes on activity). |
| Avatars look like capsules, not full characters | That's the MVP. See `ARCHITECTURE.md` §10 — upgrading to skinned boxman avatars is a documented follow-up. |
| Skin color also changed NPCs | It shouldn't — materials are cloned per local-player mesh. If you see this, the boxman shares one material instance in an unusual way; the clone guard handles the standard case. |
| `supabase is not defined` in console | The CDN script tag in `index.html` failed to load. Check your network / ad blocker; you can self-host `supabase.min.js` instead. |

---

## Tuning

In `supabase-config.js → multiplayer`:

- `sendRateHz` — how often your position broadcasts (default 20). Lower it on
  slow connections or to scale to more players.
- `heartbeatSeconds` — session freshness ping (default 5, must stay under 30).
- `browserRefreshSeconds` — how often the server list refreshes (default 5).
- `maxAvatars` — hard cap on remote avatars drawn (default 32).
- `verbose` — console logging.

Enjoy San Verano County, online. — Tha Trenches RP
