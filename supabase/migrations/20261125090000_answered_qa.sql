-- BC Dads Golf: the assistant records the questions the group has answered, as short question-and-answer pairs
-- shown in the idea's summary. Re-runnable. Deletes nothing.

alter table public.ideas add column if not exists answered_qa jsonb not null default '[]'::jsonb; -- [{"question": "...", "answer": "..."}], written only by the assistant

-- Same guard as before (members cannot change status, summary, spec or build info, except Open <-> Ready through set_ready;
-- source links only through spin_off), plus: members cannot write the answered Q&As either. Only the assistant (service role) and admins can.
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
      new.answered_qa := '[]'::jsonb;
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
      new.answered_qa := old.answered_qa;
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
