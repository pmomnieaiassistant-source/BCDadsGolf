-- BC Dads Golf: invite links.
-- An admin creates a link that works for a limited time and a limited number of people. Re-runnable. Deletes nothing.

create table if not exists public.invites (
  token text primary key default replace(gen_random_uuid()::text, '-', ''),
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uses int not null check (max_uses between 1 and 100),
  uses int not null default 0 check (uses >= 0),
  revoked boolean not null default false
);

alter table public.invites enable row level security;

-- Only admins can see invites (and so the tokens). Nobody can insert, change or delete them directly:
-- everything goes through the three functions below.
drop policy if exists invites_admin_read on public.invites;
create policy invites_admin_read on public.invites for select using (public.is_admin());

revoke all on public.invites from anon, authenticated;
grant select on public.invites to authenticated;
grant select, insert, update, delete on public.invites to service_role;

-- Admin: make a new invite link.
create or replace function public.create_invite(p_days int default 7, p_uses int default 10) returns json
language plpgsql security definer set search_path = public as $$
declare v public.invites;
begin
  if not public.is_admin() then raise exception 'Only admins can create invites.'; end if;
  if p_days is null or p_days < 1 or p_days > 30 then raise exception 'An invite can last 1 to 30 days.'; end if;
  if p_uses is null or p_uses < 1 or p_uses > 50 then raise exception 'An invite can be used by 1 to 50 people.'; end if;
  insert into public.invites (created_by, expires_at, max_uses)
  values (auth.uid(), now() + make_interval(days => p_days), p_uses)
  returning * into v;
  return json_build_object('token', v.token, 'expires_at', v.expires_at, 'max_uses', v.max_uses);
end $$;

-- Admin: cancel an invite link. People who already joined with it stay.
create or replace function public.revoke_invite(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can cancel invites.'; end if;
  update public.invites set revoked = true where token = p_token;
end $$;

-- Anyone signed in: join the group with an invite link. Someone who is already a member is not charged a use.
create or replace function public.join_with_invite(p_token text, p_name text) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_admin boolean;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select is_admin into v_admin from public.members where id = v_uid;
  if found then return json_build_object('is_admin', v_admin, 'already', true); end if;
  if char_length(v_name) < 2 or char_length(v_name) > 40 then
    raise exception 'Name must be 2 to 40 characters';
  end if;
  -- One atomic step: only counts if the link is still good, so two people can never both take the last place.
  update public.invites set uses = uses + 1
   where token = p_token and not revoked and expires_at > now() and uses < max_uses;
  if not found then
    raise exception 'That invite link is not valid or has expired. Ask for a new one.';
  end if;
  insert into public.members (id, name, is_admin) values (v_uid, v_name, false);
  return json_build_object('is_admin', false);
end $$;

revoke all on function public.create_invite(int, int) from public, anon;
revoke all on function public.revoke_invite(text) from public, anon;
revoke all on function public.join_with_invite(text, text) from public, anon;
grant execute on function public.create_invite(int, int) to authenticated;
grant execute on function public.revoke_invite(text) to authenticated;
grant execute on function public.join_with_invite(text, text) to authenticated;
