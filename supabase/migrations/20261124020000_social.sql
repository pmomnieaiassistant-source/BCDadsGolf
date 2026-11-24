-- BC Dads Golf: likes, and "most active" sorting for the social feed.
-- Re-runnable: safe to run more than once. Deletes nothing.

-- Likes on ideas and on comments. One like per member per item.
create table if not exists public.idea_likes (
  idea_id uuid not null references public.ideas(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (idea_id, member_id)
);
create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, member_id)
);

alter table public.idea_likes enable row level security;
alter table public.comment_likes enable row level security;

-- Members can see all likes, add their own, and take back their own. Nobody can like as someone else.
drop policy if exists idea_likes_read on public.idea_likes;
create policy idea_likes_read on public.idea_likes for select using (public.is_member());
drop policy if exists idea_likes_insert on public.idea_likes;
create policy idea_likes_insert on public.idea_likes for insert with check (public.is_member() and member_id = auth.uid());
drop policy if exists idea_likes_delete on public.idea_likes;
create policy idea_likes_delete on public.idea_likes for delete using (member_id = auth.uid());

drop policy if exists comment_likes_read on public.comment_likes;
create policy comment_likes_read on public.comment_likes for select using (public.is_member());
drop policy if exists comment_likes_insert on public.comment_likes;
create policy comment_likes_insert on public.comment_likes for insert with check (public.is_member() and member_id = auth.uid());
drop policy if exists comment_likes_delete on public.comment_likes;
create policy comment_likes_delete on public.comment_likes for delete using (member_id = auth.uid());

grant select, insert, delete on public.idea_likes, public.comment_likes to authenticated;
grant select, insert, update, delete on public.idea_likes, public.comment_likes to service_role;
revoke all on public.idea_likes, public.comment_likes from anon;

-- "Most active": when an idea last had a new comment or poll, so busy ideas rise to the top of the feed.
alter table public.ideas add column if not exists last_activity_at timestamptz;
update public.ideas i
   set last_activity_at = greatest(i.created_at, coalesce((select max(c.created_at) from public.comments c where c.idea_id = i.id), i.created_at))
 where i.last_activity_at is null;
alter table public.ideas alter column last_activity_at set default now();

create or replace function public.bump_idea_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.ideas
     set last_activity_at = greatest(coalesce(last_activity_at, new.created_at), new.created_at)
   where id = new.idea_id;
  return null;
end $$;

drop trigger if exists comments_bump on public.comments;
create trigger comments_bump after insert on public.comments
  for each row execute function public.bump_idea_activity();
drop trigger if exists polls_bump on public.polls;
create trigger polls_bump after insert on public.polls
  for each row execute function public.bump_idea_activity();
