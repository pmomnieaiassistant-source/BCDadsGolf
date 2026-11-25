-- BC Dads Golf: any member can mark an idea Ready to build, and any discussion can be spun off into its own idea.
-- Re-runnable. Deletes nothing.

-- ---------------------------------------------------------------- new columns
alter table public.ideas add column if not exists ready_by uuid references public.members(id) on delete set null;           -- who marked it Ready (null = the assistant, or not Ready)
alter table public.ideas add column if not exists source_idea_id uuid references public.ideas(id) on delete set null;       -- the idea this one was spun off from
alter table public.ideas add column if not exists source_comment_id uuid references public.comments(id) on delete set null; -- the comment it started from
alter table public.comments add column if not exists spun_idea_id uuid references public.ideas(id) on delete set null;      -- on a note: the new idea that was started

-- ---------------------------------------------------------------- guards
-- Members still cannot change an idea's status, summary, spec or build info, EXCEPT: a member can flip an idea between Open and Ready,
-- and only through set_ready() below (which raises a flag for this one statement). The links to a source idea are only kept when spin_off() made them.
create or replace function public.ideas_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_toggle boolean := coalesce(current_setting('app.ready_toggle', true), '') = '1';
  v_spin   boolean := coalesce(current_setting('app.spin', true), '') = '1';
begin
  if auth.uid() is not null and not public.is_admin() then
    if tg_op = 'INSERT' then
      new.status := 'open';
      new.summary := null;
      new.open_questions := '[]'::jsonb;
      new.spec := null;
      new.built_version := null;
      new.built_at := null;
      new.ai_updated_at := null;
      new.ready_by := null;
      if not v_spin then new.source_idea_id := null; new.source_comment_id := null; end if;
    else
      if not (v_toggle and old.status in ('open', 'ready') and new.status in ('open', 'ready')) then
        new.status := old.status;
        new.ready_by := old.ready_by;
      end if;
      new.summary := old.summary;
      new.open_questions := old.open_questions;
      new.spec := old.spec;
      new.built_version := old.built_version;
      new.built_at := old.built_at;
      new.ai_updated_at := old.ai_updated_at;
      new.author_id := old.author_id;
      new.source_idea_id := old.source_idea_id;
      new.source_comment_id := old.source_comment_id;
    end if;
  end if;
  return new;
end $$;

-- A "started a new idea" note can only be made by spin_off(): not posted or edited by hand.
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert
  with check (public.is_member() and author_id = auth.uid() and is_ai = false and kind = 'comment' and spun_idea_id is null);

create or replace function public.comments_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then new.spun_idea_id := old.spun_idea_id; end if;
  return new;
end $$;
drop trigger if exists comments_guard on public.comments;
create trigger comments_guard before update on public.comments for each row execute function public.comments_guard();

-- ---------------------------------------------------------------- Ready to build (any member)
create or replace function public.set_ready(p_idea_id uuid, p_ready boolean) returns json
language plpgsql security definer set search_path = public as $$
declare v_status text; v_new text;
begin
  if not public.is_member() then raise exception 'Only members can do this.'; end if;
  select status into v_status from public.ideas where id = p_idea_id for update;
  if not found then raise exception 'That idea was not found.'; end if;
  if v_status not in ('open', 'ready') then
    raise exception 'This idea is already being built, so its status cannot be changed here.';
  end if;
  v_new := case when p_ready then 'ready' else 'open' end;
  if v_new <> v_status then
    perform set_config('app.ready_toggle', '1', true);
    update public.ideas set status = v_new, ready_by = case when p_ready then auth.uid() else null end where id = p_idea_id;
    perform set_config('app.ready_toggle', '', true);
  end if;
  return json_build_object('status', v_new);
end $$;

-- ---------------------------------------------------------------- spin a discussion off into its own idea (any member)
create or replace function public.spin_off(p_comment_id uuid, p_title text, p_include_replies boolean default true) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_title text := btrim(coalesce(p_title, ''));
  c public.comments;
  src public.ideas;
  r record;
  v_body text;
  v_new uuid;
  v_n int;
begin
  if not public.is_member() then raise exception 'Only members can do this.'; end if;
  if char_length(v_title) < 3 or char_length(v_title) > 140 then
    raise exception 'Give the new idea a title of 3 to 140 characters.';
  end if;
  select * into c from public.comments where id = p_comment_id;
  if not found then raise exception 'That comment was not found.'; end if;
  if c.spun_idea_id is not null then raise exception 'That note cannot be turned into an idea.'; end if;
  select * into src from public.ideas where id = c.idea_id;

  select count(*) into v_n from public.ideas
   where author_id = v_uid and source_idea_id is not null and created_at > now() - interval '1 hour';
  if v_n >= 10 then raise exception 'That is a lot of new ideas this hour. Try again a bit later.'; end if;

  -- The new idea's details are the quoted discussion, with the real authors (written here, so it cannot be faked).
  v_body := 'Started from a discussion on "' || src.title || '".' || E'\n\n'
         || case when c.is_ai then 'Assistant' else coalesce((select name from public.members where id = c.author_id), 'A member') end
         || ': ' || c.body;
  if p_include_replies then
    for r in select cc.body, cc.is_ai, cc.author_id from public.comments cc
              where cc.parent_id = c.id and cc.spun_idea_id is null order by cc.created_at loop
      v_body := v_body || E'\n\n'
             || case when r.is_ai then 'Assistant' else coalesce((select name from public.members where id = r.author_id), 'A member') end
             || ': ' || r.body;
    end loop;
  end if;
  if char_length(v_body) > 4900 then v_body := left(v_body, 4880) || E'\n\n(Trimmed.)'; end if;

  perform set_config('app.spin', '1', true);
  insert into public.ideas (author_id, title, body, source_idea_id, source_comment_id)
  values (v_uid, v_title, v_body, src.id, c.id) returning id into v_new;
  perform set_config('app.spin', '', true);

  -- Photos from the discussion come along (up to 6).
  insert into public.attachments (idea_id, comment_id, uploader_id, path)
  select v_new, null, a.uploader_id, a.path from public.attachments a
   where a.comment_id = c.id
      or (p_include_replies and a.comment_id in (select id from public.comments where parent_id = c.id))
   order by a.created_at limit 6;

  -- A note in the original thread, as a reply under the comment, that links to the new idea.
  insert into public.comments (idea_id, parent_id, author_id, body, spun_idea_id)
  values (src.id, coalesce(c.parent_id, c.id), v_uid, 'Started a new idea from this discussion: ' || v_title, v_new);

  return v_new;
end $$;

revoke all on function public.set_ready(uuid, boolean) from public, anon;
revoke all on function public.spin_off(uuid, text, boolean) from public, anon;
grant execute on function public.set_ready(uuid, boolean) to authenticated;
grant execute on function public.spin_off(uuid, text, boolean) to authenticated;
