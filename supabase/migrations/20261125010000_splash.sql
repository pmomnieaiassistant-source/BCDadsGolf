-- BC Dads Golf: splash screens (the "how the app works" guide, and future "what's new" screens).
-- Re-runnable. Deletes nothing. Built from the idea "Splash screen".
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

-- Mark the idea itself as built, and add it to the Features page.
-- Only acts if there is exactly one idea titled "Splash screen" that is in Building status.
do $$
declare v_id uuid;
begin
  if (select count(*) from public.ideas where title = 'Splash screen' and status = 'building') = 1 then
    select id into v_id from public.ideas where title = 'Splash screen' and status = 'building';
    update public.ideas set status = 'built', built_version = '0.5.0', built_at = now() where id = v_id;
    insert into public.features (idea_id, name, description, version)
    select v_id, 'Splash screen',
           'A short how-it-works guide that opens when you launch the app. Swipe through the pages, close it, or tick "Don''t show again". New "what''s new" screens use the same system, so they show up for everyone the same way.',
           '0.5.0'
    where not exists (select 1 from public.features where idea_id = v_id);
  end if;
end $$;

-- The overview at the top of the Features page: everything the app can do now.
update public.overview set updated_at = now(), body =
  'BC Dads Golf is where our group designs a golf scoring app together. Today you can post ideas with photos and polls, like and comment on them, and reply to each other with simple swipes. An assistant summarizes each idea and asks the questions that still need an answer. Friends can be invited with a link. A short guide explains how it all works when you open the app. The scoring itself will land on the Use side as ideas get built.'
where id = 1;
