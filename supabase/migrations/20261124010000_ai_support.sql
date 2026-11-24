-- BC Dads Golf: support for the AI assistant (summaries and questions).
-- Re-runnable: safe to run more than once.

-- When the assistant last updated an idea's summary.
alter table public.ideas add column if not exists ai_updated_at timestamptz;

-- A log of assistant runs. Used to limit how often it can run (cost control).
-- Only the server function can touch it: no policies, and no access for members.
create table if not exists public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid references public.ideas(id) on delete cascade,
  member_id uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  input_tokens int,
  output_tokens int,
  ok boolean
);
create index if not exists ai_runs_idea_idx on public.ai_runs (idea_id, created_at desc);
create index if not exists ai_runs_time_idx on public.ai_runs (created_at desc);
alter table public.ai_runs enable row level security;
revoke all on public.ai_runs from anon, authenticated;

-- The server function connects as service_role. Give it the table access it needs.
grant usage on schema public to service_role;
grant select, insert, update, delete on
  public.members, public.ideas, public.comments, public.attachments,
  public.polls, public.poll_options, public.poll_votes, public.ai_runs
to service_role;

-- Members must not be able to reset the assistant's cooldown, so ai_updated_at
-- joins the list of fields only admins (and the server function) can change.
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
      new.ai_updated_at := null;
    else
      new.status := old.status;
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
