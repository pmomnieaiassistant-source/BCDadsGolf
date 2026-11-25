-- BC Dads Golf: lets Claude Code read the ideas board and move ideas along, through one narrow door.
-- Re-runnable. Deletes nothing.
--
-- The door itself is the "agent-board" function (supabase/functions/agent-board). It needs a secret key and can only:
-- list ideas, read one idea with its discussion, and move an idea Ready -> Building -> Built.
-- This file adds the audit log it writes to, and the table access it needs.

-- Every read and change the agent makes, so Paul can always see what happened.
create table if not exists public.agent_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  action text not null,
  idea_id uuid references public.ideas(id) on delete set null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists agent_log_at_idx on public.agent_log (at desc);
alter table public.agent_log enable row level security;  -- no policies: members cannot read it
revoke all on public.agent_log from anon, authenticated;
grant select, insert on public.agent_log to service_role;

-- The function connects as service_role. These are the tables it reads or writes besides the ones it already has.
grant select, insert, update, delete on public.features, public.overview to service_role;
grant select on public.idea_likes, public.comment_likes to service_role;
