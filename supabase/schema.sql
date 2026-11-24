-- ============================================================================
--  Realism Roleplay — Multiplayer schema for Supabase
--  Run in: Supabase Dashboard → SQL Editor → New query → Run
--
--  This is a CLEAN INSTALL script. It:
--    1. Drops any existing servers / server_sessions tables + functions
--       (handles ANY prior state — wrong columns, wrong constraints, leftover
--        tables from other frameworks, partial runs, etc.)
--    2. Recreates them with the correct schema
--    3. Inserts the 3 default public servers
--    4. Creates the helper functions (list_servers, get_server_by_code, reaper)
--    5. Enables RLS with permissive policies for the anon key
--    6. Enables Realtime on the servers table
--
--  Safe to re-run any number of times. It always leaves the database in the
--  correct state. (It WILL wipe user-created servers and sessions — that's
--  intended for a fresh install / reset.)
-- ============================================================================

-- pgcrypto for gen_random_uuid()
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
--  1. Clean slate — drop everything we own, regardless of current shape
--     Drop in dependency order: sessions (FK) before servers; functions last.
-- ----------------------------------------------------------------------------
drop function if exists public.get_server_by_code(text);
drop function if exists public.list_servers();
drop function if exists public.reap_stale_sessions();
drop table if exists public.server_sessions cascade;
drop table if exists public.servers cascade;

-- ----------------------------------------------------------------------------
--  2. Tables (correct schema, created fresh)
-- ----------------------------------------------------------------------------
create table public.servers (
    id           uuid        primary key default gen_random_uuid(),
    name         text        not null,
    is_public    boolean     not null default true,
    join_code    text,                                    -- nullable; required only when is_public = false
    owner_id     uuid,                                    -- client-side player id of the creator
    max_players  integer     not null default 16 check (max_players between 1 and 64),
    seed         integer     not null default 1337,
    is_default   boolean     not null default false,      -- marks the 3 seeded servers
    created_at   timestamptz not null default now()
);

create table public.server_sessions (
    id           uuid        primary key,                  -- = player_id (one row per player per server)
    server_id    uuid        not null references public.servers(id) on delete cascade,
    player_id    uuid        not null,
    player_name  text        not null default 'Player',
    skin_color   text        not null default '#c68642',
    last_seen    timestamptz not null default now(),
    joined_at    timestamptz not null default now(),
    unique (server_id, player_id)
);

create index server_sessions_server_idx on public.server_sessions(server_id);
create index server_sessions_seen_idx   on public.server_sessions(last_seen);

-- ----------------------------------------------------------------------------
--  3. The 3 default public servers (fixed UUIDs → idempotent on re-runs)
-- ----------------------------------------------------------------------------
insert into public.servers (id, name, is_public, join_code, owner_id, max_players, seed, is_default, created_at) values
    ('11111111-0000-0000-0000-000000000001', 'San Verano — Downtown',  true, null, null, 24, 1337, true, now()),
    ('22222222-0000-0000-0000-000000000002', 'San Verano — Westside',  true, null, null, 24, 1337, true, now()),
    ('33333333-0000-0000-0000-000000000003', 'San Verano — Northside', true, null, null, 24, 1337, true, now());

-- ----------------------------------------------------------------------------
--  4. Helper functions
-- ----------------------------------------------------------------------------

-- Reaper: deletes session rows not seen in the last 60 seconds.
-- Call from the client when opening the server browser; optionally schedule
-- with pg_cron: select cron.schedule('reap', '* * * * *', 'select public.reap_stale_sessions()');
create or replace function public.reap_stale_sessions()
returns integer
language sql
security definer
set search_path = public
as $$
    with deleted as (
        delete from public.server_sessions
        where last_seen < now() - interval '60 seconds'
        returning 1
    )
    select count(*)::integer from deleted;
$$;

-- Server browser query: every server with a live player_count
-- (sessions seen < 30s ago). Private servers are included so "Join by Code"
-- works; the client hides them from the public list.
create or replace function public.list_servers()
returns table (
    id           uuid,
    name         text,
    is_public    boolean,
    join_code    text,
    max_players  integer,
    seed         integer,
    is_default   boolean,
    created_at   timestamptz,
    player_count integer
)
language sql
security definer
set search_path = public
as $$
    select
        s.id,
        s.name,
        s.is_public,
        s.join_code,
        s.max_players,
        s.seed,
        s.is_default,
        s.created_at,
        coalesce((
            select count(*)::integer
            from public.server_sessions ss
            where ss.server_id = s.id
              and ss.last_seen > now() - interval '30 seconds'
        ), 0) as player_count
    from public.servers s
    order by s.is_default desc, s.created_at asc;
$$;

-- Look up a single server by its join code (for "Join by Code").
create or replace function public.get_server_by_code(p_code text)
returns table (
    id           uuid,
    name         text,
    is_public    boolean,
    join_code    text,
    max_players  integer,
    seed         integer,
    player_count integer
)
language sql
security definer
set search_path = public
as $$
    select
        s.id, s.name, s.is_public, s.join_code, s.max_players, s.seed,
        coalesce((
            select count(*)::integer
            from public.server_sessions ss
            where ss.server_id = s.id
              and ss.last_seen > now() - interval '30 seconds'
        ), 0)
    from public.servers s
    where s.join_code = upper(p_code)
    limit 1;
$$;

-- ----------------------------------------------------------------------------
--  5. Row Level Security
--     MVP uses the anon key (no Supabase Auth yet) → permissive policies.
--     See MULTIPLAYER_SETUP.md §"Tightening security" for the auth-scoped version.
-- ----------------------------------------------------------------------------
alter table public.servers          enable row level security;
alter table public.server_sessions  enable row level security;

drop policy if exists "servers_read"   on public.servers;
drop policy if exists "servers_insert" on public.servers;
drop policy if exists "servers_update" on public.servers;
drop policy if exists "servers_delete" on public.servers;
create policy "servers_read"   on public.servers for select using (true);
create policy "servers_insert" on public.servers for insert with check (true);
create policy "servers_update" on public.servers for update using (true) with check (true);
create policy "servers_delete" on public.servers for delete using (true);

drop policy if exists "sessions_read"   on public.server_sessions;
drop policy if exists "sessions_insert" on public.server_sessions;
drop policy if exists "sessions_update" on public.server_sessions;
drop policy if exists "sessions_delete" on public.server_sessions;
create policy "sessions_read"   on public.server_sessions for select using (true);
create policy "sessions_insert" on public.server_sessions for insert with check (true);
create policy "sessions_update" on public.server_sessions for update using (true) with check (true);
create policy "sessions_delete" on public.server_sessions for delete using (true);

-- ----------------------------------------------------------------------------
--  6. Realtime on the servers table (Broadcast/Presence don't need this,
--     but it lets a future version live-update the browser. Harmless.)
-- ----------------------------------------------------------------------------
alter publication supabase_realtime add table public.servers;

-- ============================================================================
--  Done. Verify with:
--    select name, is_public, is_default from public.servers order by name;
--  Should return 3 rows: Downtown / Northside / Westside.
-- ============================================================================
