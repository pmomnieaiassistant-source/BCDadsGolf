-- BC Dads Golf: splash screens (the "how the app works" guide, and future "what's new" screens).
-- Re-runnable. Deletes nothing. Built from the idea "Splash screen" (the idea is moved to Built, and listed as a feature, by the agent door).
--
-- To add a "what's new" screen later, add a row to public.splashes (kind 'whatsnew') in a new migration.
-- Members who joined before it was added see it once per launch until they tick "Don't show again".

create table if not exists public.splashes (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  kind text not null check (kind in ('howto', 'whatsnew')),
  title text not null check (char_length(title) between 1 and 80),
  -- A list of pages: [{"icon": "flag", "title": "...", "body": "..."}, ...]. Plain text only.
  pages jsonb not null check (jsonb_typeof(pages) = 'array' and jsonb_array_length(pages) between 1 and 8),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Who has ticked "Don't show again" on which screen. A member can only see and change their own rows.
create table if not exists public.splash_hidden (
  member_id uuid not null references public.members(id) on delete cascade,
  splash_id text not null references public.splashes(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (member_id, splash_id)
);

alter table public.splashes enable row level security;
alter table public.splash_hidden enable row level security;

-- Members can read the screens. Nobody can change them from the app: they ship in migrations.
drop policy if exists splashes_read on public.splashes;
create policy splashes_read on public.splashes for select using (public.is_member() and active);

drop policy if exists splash_hidden_read on public.splash_hidden;
create policy splash_hidden_read on public.splash_hidden for select using (member_id = auth.uid());
drop policy if exists splash_hidden_insert on public.splash_hidden;
create policy splash_hidden_insert on public.splash_hidden for insert with check (public.is_member() and member_id = auth.uid());
drop policy if exists splash_hidden_delete on public.splash_hidden;
create policy splash_hidden_delete on public.splash_hidden for delete using (member_id = auth.uid());

revoke all on public.splashes, public.splash_hidden from anon, authenticated;
grant select on public.splashes to authenticated;
grant select, insert, delete on public.splash_hidden to authenticated;
grant select, insert, update, delete on public.splashes, public.splash_hidden to service_role;

-- The first screen: how the app works.
insert into public.splashes (id, kind, title, pages) values (
  'howto-v1', 'howto', 'How the app works',
  '[
    {"icon": "flag",    "title": "Welcome",              "body": "BC Dads Golf is built by the group, for the group. Use is where our golf scoring will live. Create is where we decide what it becomes."},
    {"icon": "ideas",   "title": "Share an idea",        "body": "Tap \"What should the app do?\" to post an idea. Add photos or a poll. Everyone can like it, comment, and reply to each other."},
    {"icon": "reply",   "title": "Talk it through",      "body": "Swipe right on a comment to reply. Double-tap to like. Swipe in from the left edge to go back, and pull down on the feed to refresh."},
    {"icon": "sparkle", "title": "The assistant helps",  "body": "It sums up each idea and asks the questions that still need an answer, until the idea is clear enough to build."},
    {"icon": "star",    "title": "Ideas become features","body": "Paul picks which ideas get built. A built idea shows up on the Features tab, with a link back to the conversation that shaped it."}
  ]'::jsonb
) on conflict (id) do nothing;
