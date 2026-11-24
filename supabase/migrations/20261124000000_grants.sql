-- BC Dads Golf: give signed-in members permission to use the tables.
-- Row level security (who can see or change what) still decides every row.
-- Re-runnable: safe to run more than once.

grant usage on schema public to authenticated;

grant select, insert, update, delete on
  public.members, public.ideas, public.comments, public.attachments,
  public.polls, public.poll_options, public.poll_votes,
  public.features, public.overview
to authenticated;

-- Settings holds the join codes. Members must never read them directly.
revoke all on public.settings from anon, authenticated;

-- Signed-in members only; anonymous visitors get nothing.
revoke all on public.members, public.ideas, public.comments, public.attachments,
  public.polls, public.poll_options, public.poll_votes,
  public.features, public.overview from anon;
