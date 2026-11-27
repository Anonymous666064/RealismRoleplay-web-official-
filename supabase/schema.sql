-- ============================================================
--  REALISM ROLEPLAY — FULL MULTIPLAYER SCHEMA
--  (working 3D Arena schema + server registry, idempotent, safe to re-run)
--  Order matters: CREATE tables first, THEN drop/recreate policies.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. SCORES TABLE — create if missing, then patch older schema
-- ------------------------------------------------------------
create table if not exists public.scores (
  id          uuid primary key default gen_random_uuid(),
  room_id     text        not null,
  player_id   uuid,
  player_name text        not null,
  points      integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.scores add column if not exists player_id  uuid;
alter table public.scores add column if not exists created_at timestamptz not null default now();
alter table public.scores add column if not exists updated_at timestamptz not null default now();

create index if not exists scores_room_points_idx
  on public.scores (room_id, points desc);

-- ------------------------------------------------------------
-- 2. ROOM STATE TABLE — create if missing, then patch
-- ------------------------------------------------------------
create table if not exists public.room_state (
  room_id    text primary key,
  coin_x     numeric     not null default 0,
  coin_y     numeric     not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.room_state add column if not exists coin_x     numeric     not null default 0;
alter table public.room_state add column if not exists coin_y     numeric     not null default 0;
alter table public.room_state add column if not exists updated_at timestamptz not null default now();

-- ------------------------------------------------------------
-- 3. SERVERS TABLE — the server browser registry
-- ------------------------------------------------------------
create table if not exists public.servers (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null,
  is_public    boolean     not null default true,
  join_code    text,
  owner_id     uuid,
  max_players  integer     not null default 16,
  seed         integer     not null default 1337,
  is_default   boolean     not null default false,
  created_at   timestamptz not null default now()
);

alter table public.servers add column if not exists is_public    boolean;
alter table public.servers add column if not exists join_code    text;
alter table public.servers add column if not exists owner_id     uuid;
alter table public.servers add column if not exists max_players  integer default 16;
alter table public.servers add column if not exists seed         integer default 1337;
alter table public.servers add column if not exists is_default   boolean default false;
alter table public.servers add column if not exists created_at   timestamptz default now();

-- ------------------------------------------------------------
-- 4. SERVER SESSIONS TABLE — live player counts for the browser
--    player_id here is the per-connection UUID (fresh per page load,
--    same pattern as the arena template's playerId) so two tabs of the
--    same browser count as two players and never collide.
-- ------------------------------------------------------------
create table if not exists public.server_sessions (
  id          uuid        primary key default gen_random_uuid(),
  server_id   uuid        not null,
  player_id   uuid        not null,
  player_name text        not null default 'Player',
  skin_color  text        not null default '#c68642',
  last_seen   timestamptz not null default now(),
  joined_at   timestamptz not null default now()
);

alter table public.server_sessions add column if not exists player_id   uuid;
alter table public.server_sessions add column if not exists player_name text default 'Player';
alter table public.server_sessions add column if not exists skin_color  text default '#c68642';
alter table public.server_sessions add column if not exists last_seen   timestamptz default now();
alter table public.server_sessions add column if not exists joined_at   timestamptz default now();

create index if not exists server_sessions_server_idx on public.server_sessions(server_id);
create index if not exists server_sessions_seen_idx   on public.server_sessions(last_seen);

-- ------------------------------------------------------------
-- 5. SERVER BROWSER FUNCTIONS
-- ------------------------------------------------------------
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
  select s.id, s.name, s.is_public, s.join_code, s.max_players, s.seed,
         s.is_default, s.created_at,
         coalesce((
           select count(*)::integer from public.server_sessions ss
           where ss.server_id = s.id
             and ss.last_seen > now() - interval '30 seconds'
         ), 0) as player_count
  from public.servers s
  order by s.is_default desc, s.created_at asc;
$$;

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
  select s.id, s.name, s.is_public, s.join_code, s.max_players, s.seed,
         coalesce((
           select count(*)::integer from public.server_sessions ss
           where ss.server_id = s.id
             and ss.last_seen > now() - interval '30 seconds'
         ), 0) as player_count
  from public.servers s
  where s.join_code = upper(p_code)
  limit 1;
$$;

-- ------------------------------------------------------------
-- 6. DROP OLD POLICIES (tables now definitely exist)
-- ------------------------------------------------------------
drop policy if exists "scores_select_all"      on public.scores;
drop policy if exists "scores_insert_own"      on public.scores;
drop policy if exists "scores_update_own"      on public.scores;
drop policy if exists "scores_delete_own"      on public.scores;
drop policy if exists "room_state_select_all"  on public.room_state;
drop policy if exists "room_state_upsert_all"  on public.room_state;
drop policy if exists "room_state_update_all"  on public.room_state;
drop policy if exists "servers_select_all"     on public.servers;
drop policy if exists "servers_insert_all"     on public.servers;
drop policy if exists "servers_update_all"     on public.servers;
drop policy if exists "servers_delete_all"     on public.servers;
drop policy if exists "sessions_select_all"    on public.server_sessions;
drop policy if exists "sessions_insert_all"    on public.server_sessions;
drop policy if exists "sessions_update_all"    on public.server_sessions;
drop policy if exists "sessions_delete_all"    on public.server_sessions;

-- ------------------------------------------------------------
-- 7. updated_at TRIGGERS
-- ------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists scores_set_updated_at on public.scores;
create trigger scores_set_updated_at
  before update on public.scores
  for each row execute function public.tg_set_updated_at();

drop trigger if exists room_state_set_updated_at on public.room_state;
create trigger room_state_set_updated_at
  before update on public.room_state
  for each row execute function public.tg_set_updated_at();

-- ------------------------------------------------------------
-- 8. REALTIME PUBLICATION
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'scores'
  ) then
    alter publication supabase_realtime add table public.scores;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_state'
  ) then
    alter publication supabase_realtime add table public.room_state;
  end if;
end $$;

-- ------------------------------------------------------------
-- 9. GRANTS
-- ------------------------------------------------------------
grant select on public.scores to anon, authenticated;
grant insert, update, delete on public.scores to anon, authenticated;
grant select, insert, update on public.room_state to anon, authenticated;
grant select, insert, update, delete on public.servers to anon, authenticated;
grant select, insert, update, delete on public.server_sessions to anon, authenticated;
grant execute on function public.list_servers() to anon, authenticated;
grant execute on function public.get_server_by_code(text) to anon, authenticated;
grant execute on function public.reap_stale_sessions() to anon, authenticated;

-- ------------------------------------------------------------
-- 10. RLS
-- ------------------------------------------------------------
alter table public.scores          enable row level security;
alter table public.room_state      enable row level security;
alter table public.servers         enable row level security;
alter table public.server_sessions enable row level security;

create policy "scores_select_all"
  on public.scores for select
  using (true);

create policy "scores_insert_own"
  on public.scores for insert
  with check (player_id = auth.uid());

create policy "scores_update_own"
  on public.scores for update
  using  (player_id = auth.uid())
  with check (player_id = auth.uid());

create policy "scores_delete_own"
  on public.scores for delete
  using (player_id = auth.uid());

create policy "room_state_select_all"
  on public.room_state for select
  using (true);

create policy "room_state_upsert_all"
  on public.room_state for insert
  with check (true);

create policy "room_state_update_all"
  on public.room_state for update
  using (true);

-- servers + server_sessions: permissive for the anon key (browser MVP)
create policy "servers_select_all"
  on public.servers for select
  using (true);

create policy "servers_insert_all"
  on public.servers for insert
  with check (true);

create policy "servers_update_all"
  on public.servers for update
  using (true);

create policy "servers_delete_all"
  on public.servers for delete
  using (true);

create policy "sessions_select_all"
  on public.server_sessions for select
  using (true);

create policy "sessions_insert_all"
  on public.server_sessions for insert
  with check (true);

create policy "sessions_update_all"
  on public.server_sessions for update
  using (true);

create policy "sessions_delete_all"
  on public.server_sessions for delete
  using (true);

-- ------------------------------------------------------------
-- 11. SEED DEFAULT DATA
-- ------------------------------------------------------------
insert into public.room_state (room_id, coin_x, coin_y)
values ('00000000-0000-0000-0000-000000000001', 0, 0)
on conflict (room_id) do nothing;

insert into public.servers (id, name, is_public, join_code, owner_id, max_players, seed, is_default, created_at) values
  ('11111111-0000-0000-0000-000000000001', 'San Verano — Downtown',  true, null, null, 24, 1337, true, now()),
  ('22222222-0000-0000-0000-000000000002', 'San Verano — Westside',  true, null, null, 24, 1337, true, now()),
  ('33333333-0000-0000-0000-000000000003', 'San Verano — Northside', true, null, null, 24, 1337, true, now())
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 12. VERIFICATION — inspect final schema
-- ------------------------------------------------------------
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('scores', 'room_state', 'servers', 'server_sessions')
order by table_name, ordinal_position;
