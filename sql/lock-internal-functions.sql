-- ============================================================
-- Security: lock internal helper functions away from clients
-- ============================================================
-- Postgres lets every role run a new function unless told otherwise, and
-- Supabase exposes every function in `public` as an RPC. So these helpers,
-- which were only ever meant to be called by other database functions,
-- could be called straight from a browser by anyone signed in (and some by
-- anyone holding the public anon key):
--
--   send_push_to_users / send_push_to_group
--       push any text to any user's phone, under the Union name
--   send_email / notify_group_members
--       send any email, or any HTML to a whole group, from Union's address
--   _demo_ensure_auth_user
--       create a confirmed account without an invite, or test whether an
--       email is registered
--   _demo_ensure_contact_pair
--       make any two people contacts of each other
--
-- This file takes that access away. Database functions and triggers that use
-- these helpers keep working, because they run with the owner's rights.
--
-- The app called send_push_to_users directly in two places (location share
-- started, phone/email shared). Those now go through two narrow functions
-- below that write the message on the server and check the share is real.
--
-- Safe to run more than once. Run the whole file in the Supabase SQL Editor.
-- ============================================================

-- ---------- 0. Safety check ----------
-- If some function that runs with the *caller's* rights uses one of these
-- helpers, taking access away would break it. Stop before changing anything.
do $$
declare
  v_bad text;
begin
  select string_agg(p.proname, ', ')
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and not p.prosecdef
     and p.proname not in (
       'send_push_to_users', 'send_push_to_group', 'send_email',
       'notify_group_members', '_demo_ensure_auth_user', '_demo_ensure_contact_pair'
     )
     and p.prosrc ~* '(send_push_to_users|send_push_to_group|send_email|notify_group_members|_demo_ensure_auth_user|_demo_ensure_contact_pair)\s*\(';

  if v_bad is not null then
    raise exception
      'Not locking anything: these functions run with the caller''s rights and use a helper that is about to be locked: %. Make them SECURITY DEFINER (or stop them calling the helper) first.', v_bad;
  end if;
end $$;


-- ---------- 1. Take client access away ----------
-- Loops over whatever versions exist in this database, so it does not matter
-- if a helper's argument list differs from the copy in this repo.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'send_push_to_users', 'send_push_to_group', 'send_email',
         'notify_group_members', '_demo_ensure_auth_user', '_demo_ensure_contact_pair'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;


-- ---------- 2. Location share started ----------
-- Replaces the app's direct send_push_to_users call. The caller can only
-- notify someone they started sharing with in the last few minutes, and the
-- wording is fixed here.
create or replace function public.notify_location_share_started(p_contact_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
begin
  if v_uid is null then
    raise exception 'You must be logged in';
  end if;
  if p_contact_id is null or p_contact_id = v_uid then
    return;
  end if;

  if not exists (
    select 1
      from public.location_shares ls
     where ls.from_user_id = v_uid
       and ls.to_user_id = p_contact_id
       and ls.started_at > now() - interval '5 minutes'
       and (ls.expires_at is null or ls.expires_at > now())
  ) then
    return;
  end if;

  if exists (
    select 1 from public.blocked_users b
     where (b.blocker_id = p_contact_id and b.blocked_id = v_uid)
        or (b.blocker_id = v_uid and b.blocked_id = p_contact_id)
  ) then
    return;
  end if;

  select coalesce(nullif(btrim(display_name), ''), 'Someone')
    into v_name
    from public.profiles
   where id = v_uid;

  perform public.send_push_to_users(
    array[p_contact_id],
    v_uid,
    'Union',
    coalesce(v_name, 'Someone') || ' started sharing location with you'
  );
end;
$$;

revoke all on function public.notify_location_share_started(uuid) from public, anon;
grant execute on function public.notify_location_share_started(uuid) to authenticated;


-- ---------- 3. Phone / email shared with a contact ----------
-- Replaces the app's other direct send_push_to_users call. The caller says
-- which of the four things happened; the sentence is built here. Only works
-- when the caller really is sharing a phone number or email with that contact.
create or replace function public.notify_contact_info_shared(
  p_contact_id uuid,
  p_phone_first boolean default false,
  p_phone_update boolean default false,
  p_email_first boolean default false,
  p_email_update boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
  v_has_phone boolean;
  v_has_email boolean;
  v_seg text[] := '{}';
  v_body text;
begin
  if v_uid is null then
    raise exception 'You must be logged in';
  end if;
  if p_contact_id is null or p_contact_id = v_uid then
    return;
  end if;

  select (cs.shared_phone is not null and btrim(cs.shared_phone) <> ''),
         (cs.shared_email is not null and btrim(cs.shared_email) <> '')
    into v_has_phone, v_has_email
    from public.contact_shared cs
   where cs.user_id = v_uid
     and cs.contact_id = p_contact_id;

  if not found then
    return;
  end if;

  if exists (
    select 1 from public.blocked_users b
     where (b.blocker_id = p_contact_id and b.blocked_id = v_uid)
        or (b.blocker_id = v_uid and b.blocked_id = p_contact_id)
  ) then
    return;
  end if;

  if v_has_phone then
    if coalesce(p_phone_first, false) then
      v_seg := v_seg || 'shared their phone number'::text;
    elsif coalesce(p_phone_update, false) then
      v_seg := v_seg || 'updated the phone number they share'::text;
    end if;
  end if;
  if v_has_email then
    if coalesce(p_email_first, false) then
      v_seg := v_seg || 'shared their email'::text;
    elsif coalesce(p_email_update, false) then
      v_seg := v_seg || 'updated the email they share'::text;
    end if;
  end if;

  if coalesce(array_length(v_seg, 1), 0) = 0 then
    return;
  end if;

  select coalesce(nullif(btrim(display_name), ''), 'Someone')
    into v_name
    from public.profiles
   where id = v_uid;
  v_name := coalesce(v_name, 'Someone');

  if array_length(v_seg, 1) = 1 then
    v_body := v_name || ' ' || v_seg[1] || ' with you.';
  else
    v_body := v_name || ' ' || v_seg[1] || ' and ' || v_seg[2] || ' with you.';
  end if;

  perform public.send_push_to_users(
    array[p_contact_id],
    v_uid,
    'Union',
    v_body,
    '/?action=view_contact&contact=' || v_uid::text
  );
end;
$$;

revoke all on function public.notify_contact_info_shared(uuid, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.notify_contact_info_shared(uuid, boolean, boolean, boolean, boolean) to authenticated;


-- ---------- 4. Check ----------
-- Every row should say false in both columns.
select p.oid::regprocedure as function,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_run,
       has_function_privilege('authenticated', p.oid, 'execute') as signed_in_can_run
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     'send_push_to_users', 'send_push_to_group', 'send_email',
     'notify_group_members', '_demo_ensure_auth_user', '_demo_ensure_contact_pair'
   )
 order by 1;
