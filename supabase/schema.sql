-- BC Dads Golf: database setup (v1)
-- Run this whole file once in Supabase: SQL Editor > New query > paste > Run.
-- It is safe to run again; it only creates what is missing.
--
-- BEFORE YOU RUN: change the two codes in the "settings" section below.
--   invite_code : give this to the dads so they can join
--   admin_code  : only for you; joining with it makes you the admin

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables

create table if not exists public.members (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 40),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value text not null
);

create table if not exists public.ideas (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.members(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 140),
  body text not null default '' check (char_length(body) <= 5000),
  status text not null default 'open' check (status in ('open','ready','building','built')),
  summary text,
  open_questions jsonb not null default '[]'::jsonb,
  spec text,
  built_version text,
  built_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  parent_id uuid references public.comments(id) on delete cascade,
  author_id uuid references public.members(id) on delete cascade, -- null = the AI assistant
  is_ai boolean not null default false,
  kind text not null default 'comment' check (kind in ('comment','question')),
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index if not exists comments_idea_idx on public.comments(idea_id, created_at);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  comment_id uuid references public.comments(id) on delete cascade,
  uploader_id uuid not null references public.members(id) on delete cascade,
  path text not null,
  created_at timestamptz not null default now()
);
create index if not exists attachments_idea_idx on public.attachments(idea_id);

create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.ideas(id) on delete cascade,
  created_by uuid not null references public.members(id) on delete cascade,
  question text not null check (char_length(question) between 3 and 200),
  created_at timestamptz not null default now()
);
create index if not exists polls_idea_idx on public.polls(idea_id);

create table if not exists public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 100),
  unique (id, poll_id)
);

create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls(id) on delete cascade,
  option_id uuid not null,
  voter_id uuid not null references public.members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, voter_id),
  foreign key (option_id, poll_id) references public.poll_options(id, poll_id) on delete cascade
);

create table if not exists public.features (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid references public.ideas(id) on delete set null,
  name text not null,
  description text not null default '',
  version text,
  created_at timestamptz not null default now()
);

create table if not exists public.overview (
  id int primary key check (id = 1),
  body text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.overview (id, body) values (1, '') on conflict (id) do nothing;

-- ---------------------------------------------------------------- settings (EDIT THESE)

insert into public.settings (key, value) values
  ('invite_code', 'CHANGE-ME-INVITE'),
  ('admin_code',  'CHANGE-ME-ADMIN')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- helpers

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where id = auth.uid());
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where id = auth.uid() and is_admin);
$$;

-- Join the group with a code. Returns whether the person is an admin.
create or replace function public.join_group(p_code text, p_name text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_admin boolean := false;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 40 then
    raise exception 'Name must be 2 to 40 characters';
  end if;
  if p_code is not distinct from (select value from public.settings where key = 'admin_code') then
    v_admin := true;
  elsif p_code is not distinct from (select value from public.settings where key = 'invite_code') then
    v_admin := false;
  else
    raise exception 'That code is not right';
  end if;
  insert into public.members (id, name, is_admin) values (v_uid, v_name, v_admin)
  on conflict (id) do update
    set name = excluded.name,
        is_admin = public.members.is_admin or excluded.is_admin;
  return json_build_object('is_admin', v_admin);
end $$;

revoke all on function public.join_group(text, text) from public, anon;
grant execute on function public.join_group(text, text) to authenticated;

-- Only admins (and the AI, which uses the service role) may change status,
-- summary, spec and build info. Everyone else's changes to those are ignored.
create or replace function public.ideas_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if tg_op = 'INSERT' then
      new.status := 'open';
      new.summary := null;
      new.open_questions := '[]'::jsonb;
      new.spec := null;
      new.built_version := null;
      new.built_at := null;
    else
      new.status := old.status;
      new.summary := old.summary;
      new.open_questions := old.open_questions;
      new.spec := old.spec;
      new.built_version := old.built_version;
      new.built_at := old.built_at;
      new.author_id := old.author_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists ideas_guard on public.ideas;
create trigger ideas_guard before insert or update on public.ideas
  for each row execute function public.ideas_guard();

-- ---------------------------------------------------------------- row level security

alter table public.members      enable row level security;
alter table public.settings     enable row level security;  -- no policies: nobody can read codes
alter table public.ideas        enable row level security;
alter table public.comments     enable row level security;
alter table public.attachments  enable row level security;
alter table public.polls        enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes   enable row level security;
alter table public.features     enable row level security;
alter table public.overview     enable row level security;

drop policy if exists members_read on public.members;
create policy members_read on public.members for select
  using (id = auth.uid() or public.is_member());

-- ideas
drop policy if exists ideas_read on public.ideas;
create policy ideas_read on public.ideas for select using (public.is_member());
drop policy if exists ideas_insert on public.ideas;
create policy ideas_insert on public.ideas for insert
  with check (public.is_member() and author_id = auth.uid());
drop policy if exists ideas_update on public.ideas;
create policy ideas_update on public.ideas for update
  using (author_id = auth.uid() or public.is_admin());
drop policy if exists ideas_delete on public.ideas;
create policy ideas_delete on public.ideas for delete
  using (author_id = auth.uid() or public.is_admin());

-- comments (the AI's comments are written with the service role, which bypasses RLS)
drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select using (public.is_member());
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert
  with check (public.is_member() and author_id = auth.uid() and is_ai = false and kind = 'comment');
drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments for update
  using (author_id = auth.uid()) with check (author_id = auth.uid() and is_ai = false);
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete
  using (author_id = auth.uid() or public.is_admin());

-- attachments
drop policy if exists attachments_read on public.attachments;
create policy attachments_read on public.attachments for select using (public.is_member());
drop policy if exists attachments_insert on public.attachments;
create policy attachments_insert on public.attachments for insert
  with check (public.is_member() and uploader_id = auth.uid());
drop policy if exists attachments_delete on public.attachments;
create policy attachments_delete on public.attachments for delete
  using (uploader_id = auth.uid() or public.is_admin());

-- polls
drop policy if exists polls_read on public.polls;
create policy polls_read on public.polls for select using (public.is_member());
drop policy if exists polls_insert on public.polls;
create policy polls_insert on public.polls for insert
  with check (public.is_member() and created_by = auth.uid());
drop policy if exists polls_delete on public.polls;
create policy polls_delete on public.polls for delete
  using (created_by = auth.uid() or public.is_admin());

drop policy if exists poll_options_read on public.poll_options;
create policy poll_options_read on public.poll_options for select using (public.is_member());
drop policy if exists poll_options_insert on public.poll_options;
create policy poll_options_insert on public.poll_options for insert
  with check (exists (select 1 from public.polls p where p.id = poll_id and p.created_by = auth.uid()));

drop policy if exists poll_votes_read on public.poll_votes;
create policy poll_votes_read on public.poll_votes for select using (public.is_member());
drop policy if exists poll_votes_insert on public.poll_votes;
create policy poll_votes_insert on public.poll_votes for insert
  with check (public.is_member() and voter_id = auth.uid());
drop policy if exists poll_votes_update on public.poll_votes;
create policy poll_votes_update on public.poll_votes for update
  using (voter_id = auth.uid()) with check (voter_id = auth.uid());
drop policy if exists poll_votes_delete on public.poll_votes;
create policy poll_votes_delete on public.poll_votes for delete using (voter_id = auth.uid());

-- features and overview: everyone in the group reads, only admins write
drop policy if exists features_read on public.features;
create policy features_read on public.features for select using (public.is_member());
drop policy if exists features_write on public.features;
create policy features_write on public.features for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists overview_read on public.overview;
create policy overview_read on public.overview for select using (public.is_member());
drop policy if exists overview_write on public.overview;
create policy overview_write on public.overview for update
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- photo storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists photos_upload on storage.objects;
create policy photos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member()
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
