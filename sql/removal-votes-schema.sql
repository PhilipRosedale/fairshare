-- Removing a member by group vote.
--
-- Mirrors how people get in: nobody removes a member alone. Any active member
-- proposes it, the other active members vote, and the member is removed once
-- the votes reach the same share the group uses for admissions
-- ($NEW_MEMBER_PERCENTAGE, default 100%), within the same voting period
-- ($VOTING_PERIOD_DAYS, if the constitution sets one).
--
-- One deliberate difference from admissions: after the voting period ends,
-- admissions count only the people who voted. For removals that would let a
-- single vote remove someone once everyone else stays quiet, so a removal
-- additionally needs at least a simple majority of the eligible members
-- (everyone active except the person being voted on) no matter what.
--
-- Clients never write these tables directly; everything goes through the
-- SECURITY DEFINER functions below. Run in Supabase SQL Editor.

create table if not exists public.removal_proposals (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  target_id uuid not null references public.profiles(id),
  proposer_id uuid not null references public.profiles(id),
  reason text,
  status text not null default 'open' check (status in ('open', 'passed', 'expired', 'withdrawn')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists removal_proposals_one_open_per_target
  on public.removal_proposals (group_id, target_id) where status = 'open';

create table if not exists public.removal_votes (
  proposal_id uuid not null references public.removal_proposals(id) on delete cascade,
  voter_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (proposal_id, voter_id)
);

alter table public.removal_proposals enable row level security;
alter table public.removal_votes enable row level security;

drop policy if exists "Group members can view removal proposals" on public.removal_proposals;
create policy "Group members can view removal proposals"
  on public.removal_proposals for select
  using (public.is_group_member(group_id) or auth.uid() = target_id);

drop policy if exists "Group members can view removal votes" on public.removal_votes;
create policy "Group members can view removal votes"
  on public.removal_votes for select
  using (exists (
    select 1 from public.removal_proposals p
    where p.id = removal_votes.proposal_id
      and (public.is_group_member(p.group_id) or auth.uid() = p.target_id)
  ));

-- Realtime so open proposals update live on everyone's Members tab.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'removal_proposals'
  ) then
    alter publication supabase_realtime add table public.removal_proposals;
  end if;
end $$;

-- Where a proposal stands right now. Also resolves it (passed / expired) when
-- the numbers say so, which is why every read path calls it first.
create or replace function public.check_removal(p_proposal_id uuid)
returns json as $$
declare
  p record;
  v_constitution text;
  v_pct numeric := 1.0;
  v_pct_match text[];
  v_period_days int;
  v_window_end timestamptz;
  v_eligible int;
  v_votes int;
  v_threshold int;
  v_majority int;
  v_target_name text;
  v_expired boolean := false;
begin
  select * into p from public.removal_proposals where id = p_proposal_id;
  if p is null then
    raise exception 'Proposal not found';
  end if;

  select constitution into v_constitution from public.groups where id = p.group_id;
  if v_constitution is not null then
    v_pct_match := regexp_match(v_constitution, ':\s*(\d+)%\s*(?:members?\s*)?\$NEW_MEMBER_PERCENTAGE');
    if v_pct_match is not null then
      v_pct := v_pct_match[1]::numeric / 100.0;
    end if;
  end if;
  v_period_days := public.get_voting_period_days(v_constitution);
  if v_period_days is not null and v_period_days > 0 then
    v_window_end := p.created_at + (v_period_days || ' days')::interval;
  end if;

  -- Everyone active except the person being voted on.
  select count(*) into v_eligible
  from public.members
  where group_id = p.group_id and status = 'active' and user_id <> p.target_id;

  select count(*) into v_votes
  from public.removal_votes v
  join public.members m on m.group_id = p.group_id and m.user_id = v.voter_id and m.status = 'active'
  where v.proposal_id = p.id;

  v_majority := floor(v_eligible / 2.0) + 1;

  if v_window_end is not null and now() >= v_window_end then
    -- Period over: the admission rule (share of those who voted) with a
    -- majority floor so silence cannot remove anyone.
    v_threshold := greatest(ceil(v_votes * v_pct), v_majority);
    v_expired := true;
  else
    v_threshold := greatest(1, ceil(v_eligible * v_pct));
  end if;

  if p.status = 'open' and v_votes >= v_threshold then
    update public.members set status = 'removed'
    where group_id = p.group_id and user_id = p.target_id and status = 'active';

    update public.removal_proposals set status = 'passed', resolved_at = now() where id = p.id;

    select display_name into v_target_name from public.profiles where id = p.target_id;
    insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
    values (p.group_id, 'member_removed',
      coalesce(v_target_name, 'A member') || ' was removed by group vote',
      p.proposer_id,
      json_build_object('user_id', p.target_id, 'proposal_id', p.id, 'votes', v_votes, 'threshold', v_threshold)::jsonb);

    begin
      perform public.send_push_to_users(
        array[p.target_id], p.proposer_id,
        'Removed from ' || (select name from public.groups where id = p.group_id),
        'The group voted to remove you.',
        '/');
    exception when others then null;
    end;

    p.status := 'passed';
  elsif p.status = 'open' and v_expired then
    update public.removal_proposals set status = 'expired', resolved_at = now() where id = p.id;
    p.status := 'expired';
  end if;

  return json_build_object(
    'id', p.id,
    'status', p.status,
    'votes', v_votes,
    'threshold', v_threshold,
    'eligible', v_eligible,
    'window_end', v_window_end
  );
end;
$$ language plpgsql security definer set search_path = public;

create or replace function public.propose_removal(p_group_id uuid, p_target_id uuid, p_reason text default null)
returns json as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
  v_me_name text;
  v_target_name text;
  v_group_name text;
  v_others uuid[];
begin
  if v_me is null then raise exception 'Not signed in'; end if;
  if p_target_id = v_me then raise exception 'You cannot propose removing yourself. Use Leave group instead.'; end if;
  if not exists (select 1 from public.members where group_id = p_group_id and user_id = v_me and status = 'active') then
    raise exception 'You are not an active member of this group';
  end if;
  if not exists (select 1 from public.members where group_id = p_group_id and user_id = p_target_id and status = 'active') then
    raise exception 'That person is not an active member of this group';
  end if;
  if exists (select 1 from public.removal_proposals where group_id = p_group_id and target_id = p_target_id and status = 'open') then
    raise exception 'There is already an open vote to remove this member';
  end if;

  insert into public.removal_proposals (group_id, target_id, proposer_id, reason)
  values (p_group_id, p_target_id, v_me, nullif(left(trim(p_reason), 280), ''))
  returning id into v_id;

  -- Proposing counts as your vote.
  insert into public.removal_votes (proposal_id, voter_id) values (v_id, v_me);

  select display_name into v_me_name from public.profiles where id = v_me;
  select display_name into v_target_name from public.profiles where id = p_target_id;
  select name into v_group_name from public.groups where id = p_group_id;

  insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
  values (p_group_id, 'removal_proposed',
    coalesce(v_me_name, 'Someone') || ' proposed removing ' || coalesce(v_target_name, 'a member') || '. Vote on the Members tab.',
    v_me,
    json_build_object('user_id', p_target_id, 'proposal_id', v_id)::jsonb);

  -- The group_events push trigger tells everyone else (the person being
  -- voted on included); no separate push needed here.

  return public.check_removal(v_id);
end;
$$ language plpgsql security definer set search_path = public;

create or replace function public.vote_removal(p_proposal_id uuid)
returns json as $$
declare
  v_me uuid := auth.uid();
  p record;
begin
  if v_me is null then raise exception 'Not signed in'; end if;
  select * into p from public.removal_proposals where id = p_proposal_id;
  if p is null then raise exception 'Proposal not found'; end if;
  if p.status <> 'open' then raise exception 'This vote is closed'; end if;
  if p.target_id = v_me then raise exception 'You cannot vote on your own removal'; end if;
  if not exists (select 1 from public.members where group_id = p.group_id and user_id = v_me and status = 'active') then
    raise exception 'You are not an active member of this group';
  end if;
  insert into public.removal_votes (proposal_id, voter_id) values (p_proposal_id, v_me)
  on conflict do nothing;
  return public.check_removal(p_proposal_id);
end;
$$ language plpgsql security definer set search_path = public;

create or replace function public.unvote_removal(p_proposal_id uuid)
returns json as $$
declare
  v_me uuid := auth.uid();
  p record;
begin
  if v_me is null then raise exception 'Not signed in'; end if;
  select * into p from public.removal_proposals where id = p_proposal_id;
  if p is null then raise exception 'Proposal not found'; end if;
  if p.status <> 'open' then raise exception 'This vote is closed'; end if;
  if p.proposer_id = v_me then raise exception 'Withdraw the proposal instead of removing your vote'; end if;
  delete from public.removal_votes where proposal_id = p_proposal_id and voter_id = v_me;
  return public.check_removal(p_proposal_id);
end;
$$ language plpgsql security definer set search_path = public;

create or replace function public.withdraw_removal(p_proposal_id uuid)
returns json as $$
declare
  v_me uuid := auth.uid();
  p record;
  v_target_name text;
begin
  if v_me is null then raise exception 'Not signed in'; end if;
  select * into p from public.removal_proposals where id = p_proposal_id;
  if p is null then raise exception 'Proposal not found'; end if;
  if p.status <> 'open' then raise exception 'This vote is closed'; end if;
  if p.proposer_id <> v_me then raise exception 'Only the person who proposed it can withdraw it'; end if;
  update public.removal_proposals set status = 'withdrawn', resolved_at = now() where id = p_proposal_id;
  select display_name into v_target_name from public.profiles where id = p.target_id;
  insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
  values (p.group_id, 'removal_withdrawn',
    'The proposal to remove ' || coalesce(v_target_name, 'a member') || ' was withdrawn',
    v_me, json_build_object('user_id', p.target_id, 'proposal_id', p.id)::jsonb);
  return json_build_object('id', p.id, 'status', 'withdrawn');
end;
$$ language plpgsql security definer set search_path = public;

-- Open proposals for a group with vote counts, resolving any that are due.
create or replace function public.list_removal_proposals(p_group_id uuid)
returns json as $$
declare
  v_me uuid := auth.uid();
  r record;
  v_out json[] := '{}';
  v_state json;
begin
  if v_me is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from public.members where group_id = p_group_id and user_id = v_me and status in ('active')) then
    return '[]'::json;
  end if;
  for r in
    select p.*, tp.display_name as target_name, pp.display_name as proposer_name,
           exists (select 1 from public.removal_votes v where v.proposal_id = p.id and v.voter_id = v_me) as i_voted
    from public.removal_proposals p
    join public.profiles tp on tp.id = p.target_id
    join public.profiles pp on pp.id = p.proposer_id
    where p.group_id = p_group_id and p.status = 'open'
    order by p.created_at
  loop
    v_state := public.check_removal(r.id);
    if (v_state->>'status') = 'open' then
      v_out := v_out || json_build_object(
        'id', r.id, 'target_id', r.target_id, 'target_name', r.target_name,
        'proposer_id', r.proposer_id, 'proposer_name', r.proposer_name,
        'reason', r.reason, 'created_at', r.created_at,
        'i_voted', r.i_voted, 'i_proposed', r.proposer_id = v_me, 'is_me', r.target_id = v_me,
        'votes', v_state->'votes', 'threshold', v_state->'threshold',
        'eligible', v_state->'eligible', 'window_end', v_state->'window_end');
    end if;
  end loop;
  return array_to_json(v_out);
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function public.check_removal(uuid) from public, anon;
grant execute on function public.check_removal(uuid) to authenticated;
grant execute on function public.propose_removal(uuid, uuid, text) to authenticated;
grant execute on function public.vote_removal(uuid) to authenticated;
grant execute on function public.unvote_removal(uuid) to authenticated;
grant execute on function public.withdraw_removal(uuid) to authenticated;
grant execute on function public.list_removal_proposals(uuid) to authenticated;
