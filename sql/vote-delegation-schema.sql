-- Liquid democracy: delegate your vote to another member, per issue type.
--
-- The constitution declares the delegable issue types with the $ISSUE_TYPES tag,
-- e.g. "...on these Issue Types: Membership, Monetary Policy $ISSUE_TYPES."
-- The list is read from the constitution text at vote time, so amendments can
-- add, rename, or remove issue types like any other tagged value.
--
-- Built-in meanings:
--   Membership       -> endorsements of candidates (check_endorsements)
--   Monetary Policy  -> fee_rate / daily_income votes (compute_tally)
--   any other type   -> accord proposals created with that issue_type (resolve_accord)
-- Constitutional amendments are never delegated; they always need direct votes.
--
-- Counting rule: every active member contributes exactly one vote. A member who
-- voted directly casts their own vote. Otherwise their vote follows their
-- delegate, then that delegate's delegate, until it reaches someone who voted.
-- If the chain ends with nobody voting, the vote is not cast.
--
-- Privacy: who delegated to whom is visible only to the delegator. Everyone
-- else sees aggregate voting power and weighted tallies.

begin;

-- ============================================================
-- Delegations table
-- ============================================================

create table if not exists public.vote_delegations (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  delegator_id uuid not null references public.profiles(id) on delete cascade,
  delegate_id uuid not null references public.profiles(id) on delete cascade,
  issue_type text not null,
  created_at timestamptz not null default now(),
  check (delegator_id <> delegate_id)
);

create unique index if not exists vote_delegations_one_per_issue
  on public.vote_delegations (group_id, delegator_id, lower(issue_type));

create index if not exists vote_delegations_delegate_idx
  on public.vote_delegations (group_id, delegate_id);

alter table public.vote_delegations enable row level security;

-- Delegations are private: members see only their own. Others see aggregate
-- voting power and tallies via get_voting_power / get_endorsement_tallies /
-- get_accord_tallies, never who delegated to whom.
drop policy if exists "Group members can view vote delegations" on public.vote_delegations;
drop policy if exists "Members can view own vote delegations" on public.vote_delegations;
create policy "Members can view own vote delegations"
  on public.vote_delegations for select
  using (delegator_id = auth.uid());

-- No insert/update/delete policies: changes go through set_vote_delegation /
-- withdraw_vote_delegation, which validate issue types.

-- Accord proposals may be tagged with an issue type so delegations apply to them.
alter table public.accord_proposals add column if not exists issue_type text;


-- ============================================================
-- Issue type helpers
-- ============================================================

-- Parse the $ISSUE_TYPES list (comma-separated, case-insensitively de-duplicated).
create or replace function public.get_issue_types(p_constitution text)
returns text[] as $$
declare
  v_match text[];
  v_item text;
  v_result text[] := '{}';
begin
  if p_constitution is null then
    return v_result;
  end if;
  v_match := regexp_match(p_constitution, ':\s*([^:\n$]*?)\s*\$ISSUE_TYPES');
  if v_match is null then
    return v_result;
  end if;
  foreach v_item in array string_to_array(v_match[1], ',') loop
    v_item := btrim(v_item);
    if v_item <> '' and not exists (
      select 1 from unnest(v_result) x where lower(x) = lower(v_item)
    ) then
      v_result := array_append(v_result, v_item);
    end if;
  end loop;
  return v_result;
end;
$$ language plpgsql immutable;

-- Canonical spelling of an issue type if the constitution declares it, else null.
create or replace function public.resolve_issue_type(p_constitution text, p_issue_type text)
returns text as $$
  select x
  from unnest(public.get_issue_types(p_constitution)) x
  where p_issue_type is not null and lower(x) = lower(btrim(p_issue_type))
  limit 1;
$$ language sql immutable;


-- ============================================================
-- Weighted tally
-- ============================================================

-- For a set of members who voted directly, return how many active members'
-- votes each one carries (themselves plus everyone whose delegation chain
-- reaches them first). p_issue_type null = no delegation, every voter weighs 1.
-- Cycles are allowed (rejecting them would reveal others' delegations); a chain
-- that loops without reaching a voter casts no vote.
create or replace function public.delegated_vote_weights(
  p_group_id uuid,
  p_issue_type text,
  p_voters uuid[]
)
returns table (voter_id uuid, weight int) as $$
  with recursive
  active as (
    select m.user_id
    from public.members m
    where m.group_id = p_group_id and m.status = 'active'
  ),
  edges as (
    select d.delegator_id, d.delegate_id
    from public.vote_delegations d
    join active a1 on a1.user_id = d.delegator_id
    join active a2 on a2.user_id = d.delegate_id
    where p_issue_type is not null
      and d.group_id = p_group_id
      and lower(d.issue_type) = lower(p_issue_type)
  ),
  walk (origin, cur, path) as (
    select a.user_id, a.user_id, array[a.user_id] from active a
    union all
    select w.origin, e.delegate_id, w.path || e.delegate_id
    from walk w
    join edges e on e.delegator_id = w.cur
    where not (w.cur = any (coalesce(p_voters, '{}'::uuid[])))
      and not (e.delegate_id = any (w.path))
  )
  select w.cur, count(*)::int
  from walk w
  where w.cur = any (coalesce(p_voters, '{}'::uuid[]))
  group by w.cur;
$$ language sql stable security definer;

revoke all on function public.delegated_vote_weights(uuid, text, uuid[]) from public, anon, authenticated;


-- ============================================================
-- Endorsements (Membership)
-- ============================================================

create or replace function public.check_endorsements(
  p_group_id uuid,
  p_candidate_id uuid
)
returns json as $$
declare
  v_active_count int;
  v_endorsement_count int;
  v_direct_count int;
  v_participants int;
  v_threshold int;
  v_constitution text;
  v_pct_match text[];
  v_pct numeric;
  v_sponsor_name text;
  v_period_days int;
  v_round_key text;
  v_opened_at timestamptz;
  v_window_end timestamptz;
  v_issue text;
  v_endorsers uuid[];
begin
  select count(*) into v_active_count
  from public.members
  where group_id = p_group_id and status = 'active';

  select constitution into v_constitution
  from public.groups
  where id = p_group_id;

  v_pct := 1.0;
  if v_constitution is not null then
    v_pct_match := regexp_match(v_constitution, ':\s*(\d+)%\s*(?:members?\s*)?\$NEW_MEMBER_PERCENTAGE');
    if v_pct_match is not null then
      v_pct := v_pct_match[1]::numeric / 100.0;
    end if;
  end if;

  v_issue := public.resolve_issue_type(v_constitution, 'Membership');
  v_period_days := public.get_voting_period_days(v_constitution);
  v_round_key := 'candidate:' || p_candidate_id::text;

  if v_period_days is not null and v_period_days > 0 then
    insert into public.vote_rounds (group_id, round_key, opened_at)
    values (p_group_id, v_round_key,
      coalesce(
        (select min(created_at) from public.endorsements
         where group_id = p_group_id and candidate_id = p_candidate_id),
        now()
      )
    )
    on conflict do nothing;

    select opened_at into v_opened_at
    from public.vote_rounds
    where group_id = p_group_id and round_key = v_round_key;

    v_window_end := v_opened_at + (v_period_days || ' days')::interval;

    select array_agg(distinct endorser_id) into v_endorsers
    from public.endorsements
    where group_id = p_group_id
      and candidate_id = p_candidate_id
      and created_at >= v_opened_at
      and created_at < v_window_end;
  else
    select array_agg(distinct endorser_id) into v_endorsers
    from public.endorsements
    where group_id = p_group_id and candidate_id = p_candidate_id;
  end if;

  v_direct_count := coalesce(cardinality(v_endorsers), 0);

  select coalesce(sum(w.weight), 0) into v_endorsement_count
  from public.delegated_vote_weights(p_group_id, v_issue, v_endorsers) w;

  if v_period_days is not null and v_period_days > 0 then
    v_participants := v_endorsement_count;
    if now() >= v_window_end then
      -- Voting period expired: threshold from the votes actually cast
      v_threshold := greatest(1, ceil(v_participants * v_pct));
    else
      -- Voting period still open: admit early once the votes cast (including
      -- delegated votes) reach the threshold of all active members
      v_threshold := greatest(1, ceil(v_active_count * v_pct));
    end if;
  else
    v_participants := null;
    v_threshold := greatest(1, ceil(v_active_count * v_pct));
  end if;

  if v_endorsement_count > 0 and v_endorsement_count >= v_threshold then
    update public.members
    set status = 'active', joined_at = now()
    where group_id = p_group_id and user_id = p_candidate_id and status = 'pending';

    delete from public.endorsements
    where group_id = p_group_id and candidate_id = p_candidate_id;

    if v_period_days is not null and v_period_days > 0 then
      delete from public.vote_rounds
      where group_id = p_group_id and round_key = v_round_key;
    end if;

    select p.display_name into v_sponsor_name
    from public.sponsorships s
    join public.profiles p on p.id = s.sponsor_id
    where s.group_id = p_group_id
      and s.candidate_id = p_candidate_id
      and s.status = 'claimed'
    limit 1;

    insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
    values (
      p_group_id,
      'member_joined',
      'New member '
        || (select display_name from public.profiles where id = p_candidate_id)
        || ' accepted'
        || case when v_sponsor_name is not null then ', sponsored by ' || v_sponsor_name else '' end,
      p_candidate_id,
      json_build_object('user_id', p_candidate_id)::jsonb
    );

    return json_build_object(
      'admitted', true,
      'endorsements', v_endorsement_count,
      'direct_endorsements', v_direct_count,
      'threshold', v_threshold,
      'participants', v_participants,
      'voting_period', v_period_days is not null
    );
  end if;

  return json_build_object(
    'admitted', false,
    'endorsements', v_endorsement_count,
    'direct_endorsements', v_direct_count,
    'threshold', v_threshold,
    'participants', v_participants,
    'voting_period', v_period_days is not null
  );
end;
$$ language plpgsql security definer;


-- ============================================================
-- Currency rate votes (Monetary Policy)
-- ============================================================

-- Replaces the 2-arg version; finalize_expired_voting already calls the 3-arg form.
drop function if exists public.compute_tally(uuid, text);

create or replace function public.compute_tally(
  p_group_id uuid,
  p_vote_type text,
  p_finalize boolean default false
)
returns json as $$
declare
  v_median numeric;
  v_vote_count int;
  v_direct_count int;
  v_active_count int;
  v_participants int;
  v_constitution text;
  v_pct_match text[];
  v_pct numeric;
  v_threshold int;
  v_applied boolean := false;
  v_period_days int;
  v_opened_at timestamptz;
  v_window_end timestamptz;
  v_expired boolean := false;
  v_issue text;
  v_voters uuid[];
begin
  if p_vote_type not in ('fee_rate', 'daily_income') then
    raise exception 'Unknown vote type: %', p_vote_type;
  end if;

  select constitution into v_constitution
  from public.groups
  where id = p_group_id;

  v_issue := public.resolve_issue_type(v_constitution, 'Monetary Policy');
  v_period_days := public.get_voting_period_days(v_constitution);

  if v_period_days is not null then
    if not exists (
      select 1 from public.votes where group_id = p_group_id and vote_type = p_vote_type
    ) then
      delete from public.vote_rounds
      where group_id = p_group_id and round_key = p_vote_type;
      return json_build_object('median', 0, 'vote_count', 0, 'applied', false, 'reason', 'No votes cast');
    end if;

    insert into public.vote_rounds (group_id, round_key, opened_at)
    values (p_group_id, p_vote_type,
      coalesce(
        (select min(created_at) from public.votes
         where group_id = p_group_id and vote_type = p_vote_type),
        now()
      )
    )
    on conflict do nothing;

    select opened_at into v_opened_at
    from public.vote_rounds
    where group_id = p_group_id and round_key = p_vote_type;

    v_window_end := v_opened_at + (v_period_days || ' days')::interval;
    v_expired := now() >= v_window_end;

    if p_finalize and not v_expired then
      return json_build_object('median', 0, 'vote_count', 0, 'applied', false, 'reason', 'Voting period not expired');
    end if;
  end if;

  select array_agg(user_id) into v_voters
  from public.votes
  where group_id = p_group_id
    and vote_type = p_vote_type
    and (v_opened_at is null or (created_at >= v_opened_at and created_at < v_window_end));

  v_direct_count := coalesce(cardinality(v_voters), 0);

  if v_direct_count = 0 then
    if v_expired then
      delete from public.vote_rounds
      where group_id = p_group_id and round_key = p_vote_type;
    end if;
    return json_build_object('median', 0, 'vote_count', 0, 'applied', false, 'reason', 'No votes cast');
  end if;

  select coalesce(sum(w.weight), 0) into v_vote_count
  from public.delegated_vote_weights(p_group_id, v_issue, v_voters) w;

  -- Weighted median: each direct vote counts once per vote it carries
  select percentile_cont(0.5) within group (order by v.value)
  into v_median
  from public.votes v
  join public.delegated_vote_weights(p_group_id, v_issue, v_voters) w on w.voter_id = v.user_id
  cross join lateral generate_series(1, w.weight)
  where v.group_id = p_group_id
    and v.vote_type = p_vote_type
    and v.user_id = any (v_voters);

  select count(*) into v_active_count
  from public.members
  where group_id = p_group_id and status = 'active';

  v_pct := 0.66;
  if v_constitution is not null then
    v_pct_match := regexp_match(v_constitution, '(\d+)%\s*(?:members?\s*)?\$CHANGE_CURRENCY_RATES_PERCENTAGE');
    if v_pct_match is not null then
      v_pct := v_pct_match[1]::numeric / 100.0;
    end if;
  end if;

  if v_period_days is not null and v_expired then
    -- Period over: threshold from the votes actually cast
    v_participants := v_vote_count;
    v_threshold := greatest(1, ceil(v_participants * v_pct));
  else
    -- Apply early once votes (including delegated votes) reach the threshold of all active members
    v_participants := case when v_period_days is not null then v_vote_count end;
    v_threshold := greatest(1, ceil(v_active_count * v_pct));
  end if;

  if v_vote_count > 0 and v_vote_count >= v_threshold and v_median is not null then
    if p_vote_type = 'fee_rate' then
      update public.groups set fee_rate = v_median where id = p_group_id;
    else
      update public.groups set daily_income = v_median where id = p_group_id;
    end if;

    delete from public.votes
    where group_id = p_group_id and vote_type = p_vote_type and user_id = any (v_voters);

    delete from public.vote_rounds
    where group_id = p_group_id and round_key = p_vote_type;

    insert into public.group_events (group_id, event_type, summary, metadata)
    values (
      p_group_id,
      'rate_change',
      case p_vote_type
        when 'fee_rate' then 'Fee rate changed to ' || round(v_median * 100, 1) || '%'
        else 'Daily income changed to ' || round(v_median, 2)
      end,
      json_build_object('vote_type', p_vote_type, 'new_value', v_median,
        'vote_count', v_vote_count, 'direct_vote_count', v_direct_count)::jsonb
    );

    v_applied := true;
  elsif v_expired then
    -- Period over without enough votes: clear this round's votes
    delete from public.votes
    where group_id = p_group_id and vote_type = p_vote_type and user_id = any (v_voters);

    delete from public.vote_rounds
    where group_id = p_group_id and round_key = p_vote_type;
  end if;

  return json_build_object(
    'median', coalesce(v_median, 0),
    'vote_count', v_vote_count,
    'direct_vote_count', v_direct_count,
    'active_members', v_active_count,
    'participants', v_participants,
    'threshold', v_threshold,
    'applied', v_applied,
    'voting_period', v_period_days is not null,
    'expired', v_expired
  );
end;
$$ language plpgsql security definer;


-- ============================================================
-- Accord proposals (any issue type)
-- ============================================================

create or replace function public.resolve_accord(p_accord_id uuid)
returns json as $$
declare
  v_accord record;
  v_active_count int;
  v_approve_count int;
  v_reject_count int;
  v_voter_count int;
  v_ratio numeric;
  v_passed boolean;
  v_constitution text;
  v_period_days int;
  v_window_end timestamptz;
  v_threshold numeric;
  v_match text[];
  v_issue text;
  v_voters uuid[];
begin
  select * into v_accord
  from public.accord_proposals
  where id = p_accord_id
  for update;

  if not found then
    raise exception 'Accord proposal not found';
  end if;

  if v_accord.status != 'voting' then
    raise exception 'Accord proposal is not in voting status';
  end if;

  if not public.is_group_member(v_accord.group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  select constitution into v_constitution
  from public.groups
  where id = v_accord.group_id;

  v_threshold := coalesce(v_accord.threshold, 0.5);

  if v_accord.threshold is null and v_constitution is not null then
    v_match := regexp_match(v_constitution, '(\d+)%\s*(?:members?\s*)?\$ACCORD_PERCENTAGE', 'i');
    if v_match is not null then
      v_threshold := greatest(0.0, least(1.0, v_match[1]::numeric / 100.0));
    end if;
  end if;

  update public.accord_proposals
  set threshold = v_threshold
  where id = p_accord_id;
  v_accord.threshold := v_threshold;

  select count(*) into v_active_count
  from public.members
  where group_id = v_accord.group_id and status = 'active';

  v_issue := public.resolve_issue_type(v_constitution, v_accord.issue_type);
  v_period_days := public.get_voting_period_days(v_constitution);
  v_window_end := v_accord.created_at + coalesce(v_period_days, 7) * interval '1 day';

  select array_agg(user_id) into v_voters
  from public.accord_votes
  where accord_id = p_accord_id
    and (v_period_days is null
         or (created_at >= v_accord.created_at and created_at < v_window_end));

  -- Approvers and rejecters both stop delegation chains, so a delegator's vote
  -- goes to whichever side their nearest voting delegate chose.
  select
    coalesce(sum(w.weight) filter (where av.vote), 0),
    coalesce(sum(w.weight) filter (where not av.vote), 0)
  into v_approve_count, v_reject_count
  from public.accord_votes av
  join public.delegated_vote_weights(v_accord.group_id, v_issue, v_voters) w on w.voter_id = av.user_id
  where av.accord_id = p_accord_id
    and av.user_id = any (coalesce(v_voters, '{}'::uuid[]));

  if v_period_days is not null then
    v_voter_count := v_approve_count + v_reject_count;
    if v_voter_count = 0 then
      v_ratio := 0;
    else
      v_ratio := v_approve_count::numeric / v_voter_count::numeric;
    end if;
  else
    v_voter_count := null;
    if v_active_count = 0 then
      v_ratio := 0;
    else
      v_ratio := v_approve_count::numeric / v_active_count::numeric;
    end if;
  end if;

  v_passed := v_ratio >= v_accord.threshold;

  if not v_passed and v_accord.expires_at > now() then
    return json_build_object(
      'resolved', false,
      'approve_count', v_approve_count,
      'reject_count', v_reject_count,
      'voter_count', v_voter_count,
      'active_members', v_active_count,
      'ratio', round(v_ratio * 100, 1),
      'threshold', round(v_accord.threshold * 100, 1),
      'voting_period', v_period_days is not null,
      'issue_type', v_issue
    );
  end if;

  if v_passed then
    update public.accord_proposals
    set status = 'passed', resolved_at = now(), threshold = v_accord.threshold
    where id = p_accord_id;

    insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
    values (
      v_accord.group_id,
      'accord_passed',
      'Accord passed',
      v_accord.proposed_by,
      json_build_object(
        'accord_id', p_accord_id,
        'proposal_text', v_accord.text,
        'approve_count', v_approve_count,
        'active_members', v_active_count,
        'issue_type', v_issue
      )::jsonb
    );
  else
    update public.accord_proposals
    set status = 'failed', resolved_at = now(), threshold = v_accord.threshold
    where id = p_accord_id;

    insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
    values (
      v_accord.group_id,
      'accord_failed',
      'Accord failed',
      v_accord.proposed_by,
      json_build_object(
        'accord_id', p_accord_id,
        'proposal_text', v_accord.text,
        'approve_count', v_approve_count,
        'active_members', v_active_count,
        'issue_type', v_issue
      )::jsonb
    );
  end if;

  return json_build_object(
    'passed', v_passed,
    'approve_count', v_approve_count,
    'reject_count', v_reject_count,
    'voter_count', v_voter_count,
    'active_members', v_active_count,
    'ratio', round(v_ratio * 100, 1),
    'threshold', round(v_accord.threshold * 100, 1),
    'voting_period', v_period_days is not null,
    'issue_type', v_issue,
    'resolved', true
  );
end;
$$ language plpgsql security definer;


-- ============================================================
-- Re-evaluate open votes after a delegation moves voting power
-- ============================================================

create or replace function public.reevaluate_delegated_issue(p_group_id uuid, p_issue_type text)
returns json as $$
declare
  v_candidate_id uuid;
  v_accord_id uuid;
  v_result json;
  v_admitted uuid[] := '{}';
  v_rates text[] := '{}';
  v_accords uuid[] := '{}';
  v_vote_type text;
begin
  if lower(p_issue_type) = 'membership' then
    for v_candidate_id in
      select m.user_id
      from public.members m
      where m.group_id = p_group_id
        and m.status = 'pending'
        and exists (
          select 1 from public.endorsements e
          where e.group_id = p_group_id and e.candidate_id = m.user_id
        )
    loop
      v_result := public.check_endorsements(p_group_id, v_candidate_id);
      if (v_result->>'admitted')::boolean then
        v_admitted := array_append(v_admitted, v_candidate_id);
      end if;
    end loop;
  end if;

  if lower(p_issue_type) = 'monetary policy' then
    foreach v_vote_type in array array['fee_rate', 'daily_income'] loop
      if exists (
        select 1 from public.votes where group_id = p_group_id and vote_type = v_vote_type
      ) then
        v_result := public.compute_tally(p_group_id, v_vote_type);
        if (v_result->>'applied')::boolean then
          v_rates := array_append(v_rates, v_vote_type);
        end if;
      end if;
    end loop;
  end if;

  for v_accord_id in
    select id
    from public.accord_proposals
    where group_id = p_group_id
      and status = 'voting'
      and expires_at > now()
      and lower(issue_type) = lower(p_issue_type)
  loop
    v_result := public.resolve_accord(v_accord_id);
    if (v_result->>'passed')::boolean then
      v_accords := array_append(v_accords, v_accord_id);
    end if;
  end loop;

  return json_build_object(
    'admitted', to_json(v_admitted),
    'rates_applied', to_json(v_rates),
    'accords_passed', to_json(v_accords)
  );
end;
$$ language plpgsql security definer;

revoke all on function public.reevaluate_delegated_issue(uuid, text) from public, anon, authenticated;


-- ============================================================
-- Client RPCs
-- ============================================================

create or replace function public.set_vote_delegation(
  p_group_id uuid,
  p_issue_type text,
  p_delegate_id uuid
)
returns json as $$
declare
  v_user_id uuid := auth.uid();
  v_constitution text;
  v_issue text;
begin
  if v_user_id is null then
    raise exception 'You must be logged in';
  end if;

  if not public.is_group_member(p_group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  if p_delegate_id is null or p_delegate_id = v_user_id then
    raise exception 'You cannot delegate your vote to yourself';
  end if;

  if not exists (
    select 1 from public.members
    where group_id = p_group_id and user_id = p_delegate_id and status = 'active'
  ) then
    raise exception 'You can only delegate to an active member of this group';
  end if;

  select constitution into v_constitution
  from public.groups
  where id = p_group_id;

  v_issue := public.resolve_issue_type(v_constitution, p_issue_type);
  if v_issue is null then
    raise exception '"%" is not an issue type declared in the group constitution', p_issue_type;
  end if;

  delete from public.vote_delegations
  where group_id = p_group_id
    and delegator_id = v_user_id
    and lower(issue_type) = lower(v_issue);

  insert into public.vote_delegations (group_id, delegator_id, delegate_id, issue_type)
  values (p_group_id, v_user_id, p_delegate_id, v_issue);

  return json_build_object(
    'success', true,
    'issue_type', v_issue,
    'delegate_id', p_delegate_id,
    'effects', public.reevaluate_delegated_issue(p_group_id, v_issue)
  );
end;
$$ language plpgsql security definer;

create or replace function public.withdraw_vote_delegation(
  p_group_id uuid,
  p_issue_type text
)
returns json as $$
declare
  v_user_id uuid := auth.uid();
  v_count int;
begin
  if v_user_id is null then
    raise exception 'You must be logged in';
  end if;

  delete from public.vote_delegations
  where group_id = p_group_id
    and delegator_id = v_user_id
    and lower(issue_type) = lower(btrim(p_issue_type));
  get diagnostics v_count = row_count;

  return json_build_object('success', true, 'withdrawn', v_count > 0);
end;
$$ language plpgsql security definer;

grant execute on function public.set_vote_delegation(uuid, text, uuid) to authenticated;
grant execute on function public.withdraw_vote_delegation(uuid, text) to authenticated;


-- ============================================================
-- Aggregate read RPCs (no delegation edges exposed)
-- ============================================================

-- Votes held by each member who has not delegated, if nobody votes directly.
-- Only members holding more than their own vote are returned, so absence from
-- the result does not reveal that someone delegated.
create or replace function public.get_voting_power(p_group_id uuid)
returns table (issue_type text, member_id uuid, votes int) as $$
#variable_conflict use_column
declare
  v_constitution text;
  v_issue text;
  v_holders uuid[];
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  select g.constitution into v_constitution
  from public.groups g
  where g.id = p_group_id;

  foreach v_issue in array public.get_issue_types(v_constitution) loop
    select array_agg(m.user_id) into v_holders
    from public.members m
    where m.group_id = p_group_id
      and m.status = 'active'
      and not exists (
        select 1
        from public.vote_delegations d
        join public.members m2
          on m2.group_id = d.group_id and m2.user_id = d.delegate_id and m2.status = 'active'
        where d.group_id = p_group_id
          and d.delegator_id = m.user_id
          and lower(d.issue_type) = lower(v_issue)
      );

    return query
      select v_issue, w.voter_id, w.weight
      from public.delegated_vote_weights(p_group_id, v_issue, v_holders) w
      where w.weight > 1;
  end loop;
end;
$$ language plpgsql stable security definer;

-- Weighted endorsement votes per pending candidate, counted as check_endorsements does.
create or replace function public.get_endorsement_tallies(p_group_id uuid)
returns table (candidate_id uuid, votes int, endorsers int) as $$
#variable_conflict use_column
declare
  v_constitution text;
  v_issue text;
  v_period_days int;
  v_candidate uuid;
  v_opened_at timestamptz;
  v_endorsers uuid[];
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  select g.constitution into v_constitution
  from public.groups g
  where g.id = p_group_id;

  v_issue := public.resolve_issue_type(v_constitution, 'Membership');
  v_period_days := public.get_voting_period_days(v_constitution);

  for v_candidate in
    select distinct e.candidate_id
    from public.endorsements e
    join public.members m
      on m.group_id = e.group_id and m.user_id = e.candidate_id and m.status = 'pending'
    where e.group_id = p_group_id
  loop
    v_opened_at := null;
    if v_period_days is not null then
      select vr.opened_at into v_opened_at
      from public.vote_rounds vr
      where vr.group_id = p_group_id and vr.round_key = 'candidate:' || v_candidate::text;
    end if;

    select array_agg(distinct e.endorser_id) into v_endorsers
    from public.endorsements e
    where e.group_id = p_group_id
      and e.candidate_id = v_candidate
      and (v_opened_at is null
           or (e.created_at >= v_opened_at
               and e.created_at < v_opened_at + (v_period_days || ' days')::interval));

    return query
      select v_candidate,
             coalesce((select sum(w.weight)::int
                       from public.delegated_vote_weights(p_group_id, v_issue, v_endorsers) w), 0),
             coalesce(cardinality(v_endorsers), 0);
  end loop;
end;
$$ language plpgsql stable security definer;

-- Weighted approve/reject votes per open accord proposal, counted as resolve_accord does.
create or replace function public.get_accord_tallies(p_group_id uuid)
returns table (accord_id uuid, approve int, reject int) as $$
#variable_conflict use_column
declare
  v_constitution text;
  v_period_days int;
  v_accord record;
  v_issue text;
  v_voters uuid[];
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  select g.constitution into v_constitution
  from public.groups g
  where g.id = p_group_id;

  v_period_days := public.get_voting_period_days(v_constitution);

  for v_accord in
    select a.id, a.created_at, a.issue_type
    from public.accord_proposals a
    where a.group_id = p_group_id and a.status = 'voting'
  loop
    v_issue := public.resolve_issue_type(v_constitution, v_accord.issue_type);

    select array_agg(av.user_id) into v_voters
    from public.accord_votes av
    where av.accord_id = v_accord.id
      and (v_period_days is null
           or (av.created_at >= v_accord.created_at
               and av.created_at < v_accord.created_at + v_period_days * interval '1 day'));

    return query
      select v_accord.id,
             coalesce(sum(w.weight) filter (where av.vote), 0)::int,
             coalesce(sum(w.weight) filter (where not av.vote), 0)::int
      from public.accord_votes av
      join public.delegated_vote_weights(p_group_id, v_issue, v_voters) w on w.voter_id = av.user_id
      where av.accord_id = v_accord.id
        and av.user_id = any (coalesce(v_voters, '{}'::uuid[]));
  end loop;
end;
$$ language plpgsql stable security definer;

grant execute on function public.get_voting_power(uuid) to authenticated;
grant execute on function public.get_endorsement_tallies(uuid) to authenticated;
grant execute on function public.get_accord_tallies(uuid) to authenticated;


-- ============================================================
-- Drop delegations to/from members who leave or are removed
-- ============================================================

create or replace function public.clear_vote_delegations_on_member_exit()
returns trigger as $$
begin
  if old.status = 'active' and new.status <> 'active' then
    delete from public.vote_delegations
    where group_id = new.group_id
      and (delegator_id = new.user_id or delegate_id = new.user_id);
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists clear_vote_delegations_on_member_exit on public.members;
create trigger clear_vote_delegations_on_member_exit
  after update of status on public.members
  for each row execute function public.clear_vote_delegations_on_member_exit();

commit;
