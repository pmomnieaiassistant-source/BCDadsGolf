-- BC Dads Golf: any member can mark an idea "Ready to build", and take it back.
-- Only while the idea is Open or Ready. Once Claude marks it Building it is locked; Built moves it to Features.
-- Re-runnable. Deletes nothing.

alter table public.ideas add column if not exists ready_by uuid references public.members(id) on delete set null; -- who marked it Ready (null = the assistant, or not Ready)

-- Members still cannot change status, summary, spec or build info, EXCEPT: flipping between Open and Ready,
-- and only through set_ready() below, which raises a flag for that one statement.
create or replace function public.ideas_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_toggle boolean := coalesce(current_setting('app.ready_toggle', true), '') = '1';
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
    end if;
  end if;
  return new;
end $$;

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

revoke all on function public.set_ready(uuid, boolean) from public, anon;
grant execute on function public.set_ready(uuid, boolean) to authenticated;
