-- ============================================================
-- FairShare Group Currency Schema
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- 1. PROFILES
-- Linked to Supabase auth.users via id. 
-- public_key is nullable now, reserved for future self-custodial auth.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  public_key text,  -- future: self-custodial identity
  last_group_id uuid,            -- last group viewed, restored on next visit
  email_notifications boolean default true,  -- opt-out of email notifications
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- Anyone can read profiles (needed to display member names)
create policy "Profiles are viewable by everyone"
  on public.profiles for select
  using (true);

-- Users can insert their own profile
create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- Users can update their own profile
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create a profile when a new user signs up.
--
-- The signup form embeds the active sponsor handshake token in the Supabase
-- auth user_metadata (raw_user_meta_data->>'meet_token' or 'invite_token').
-- We resolve the sponsor here, atomically with the auth.users insert, and
-- record the consumed token in profiles.signup_token (UNIQUE) so a given
-- handshake can be used to create at most one account. See
-- sql/sponsor-id-at-signup.sql for the migration that introduced this.
create or replace function public.handle_new_user()
returns trigger as $$
declare
  v_meet_token   text := new.raw_user_meta_data->>'meet_token';
  v_invite_token text := new.raw_user_meta_data->>'invite_token';
  v_token        text;
  v_sponsor_id   uuid;
begin
  if v_meet_token is not null then
    select user_id into v_sponsor_id
    from public.meet_requests
    where token = v_meet_token
      and expires_at > now()
      and used_by is null;
    if v_sponsor_id is null then
      raise exception 'Handshake link is invalid, expired, or already used';
    end if;
    if exists (select 1 from public.profiles where signup_token = v_meet_token) then
      raise exception 'This handshake has already been used to create an account';
    end if;
    v_token := v_meet_token;
    update public.meet_requests
    set used_by = new.id
    where token = v_meet_token;
  elsif v_invite_token is not null then
    select sponsor_id into v_sponsor_id
    from public.sponsorships
    where token = v_invite_token
      and status = 'pending'
      and expires_at > now();
    if v_sponsor_id is null then
      raise exception 'Invitation is invalid, expired, or already used';
    end if;
    if exists (select 1 from public.profiles where signup_token = v_invite_token) then
      raise exception 'This invitation has already been used to create an account';
    end if;
    v_token := v_invite_token;
  end if;

  insert into public.profiles (id, display_name, sponsor_id, signup_token)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    v_sponsor_id,
    v_token
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- 2. GROUPS
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  logo_url text,
  logo_updated_at timestamptz, -- bumps when logo changes; client uses for image cache-busting
  currency_name text not null,
  currency_symbol text not null default 'C',
  currency_enabled boolean not null default false,
  fee_rate numeric not null default 0,        -- current voted fee rate (0-1)
  daily_income numeric not null default 0,    -- current voted daily income amount
  constitution text,                          -- group constitution with tagged variables
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

alter table public.groups enable row level security;

alter table public.groups add column if not exists logo_url text;
alter table public.groups add column if not exists logo_updated_at timestamptz;
alter table public.groups add column if not exists currency_enabled boolean not null default false;

-- Anyone can read groups (needed to browse/join)
create policy "Groups are viewable by everyone"
  on public.groups for select
  using (true);

-- Any authenticated user can create a group
create policy "Authenticated users can create groups"
  on public.groups for insert
  with check (auth.uid() = created_by);

-- Only the creator can update group settings (fee_rate, daily_income updated by tally function)
create policy "Group creator or tally can update group"
  on public.groups for update
  using (auth.uid() = created_by);


-- 3. MEMBERS
create table public.members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'active', 'removed')),
  balance numeric not null default 0,
  joined_at timestamptz default now(),
  last_income_at timestamptz,              -- last time daily income was claimed (NULL = never)
  unique(group_id, user_id)
);

alter table public.members enable row level security;

-- Helper function to check group membership (SECURITY DEFINER avoids RLS recursion)
create or replace function public.is_group_member(p_group_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.members
    where group_id = p_group_id
      and user_id = auth.uid()
      and status = 'active'
  );
$$ language sql security definer stable;

-- Members can view their own memberships + members of groups they belong to
create policy "Group members can view members"
  on public.members for select
  using (
    user_id = auth.uid()
    or public.is_group_member(group_id)
  );

-- Users can join groups: as 'pending' for any group, or 'active' if they created the group
create policy "Users can request to join groups"
  on public.members for insert
  with check (
    auth.uid() = user_id
    and (
      status = 'pending'
      or (status = 'active' and exists (
        select 1 from public.groups
        where id = members.group_id and created_by = auth.uid()
      ))
    )
  );

-- No direct UPDATE policy for members.
-- All member updates (balance, status, last_income_at) go through SECURITY DEFINER
-- functions: send_currency, check_endorsements, claim_daily_income, claim_sponsorship.
-- This prevents clients from manipulating balances directly via the REST API.


-- 4. ENDORSEMENTS
create table public.endorsements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  candidate_id uuid not null references public.profiles(id) on delete cascade,
  endorser_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now(),
  unique(group_id, candidate_id, endorser_id)
);

alter table public.endorsements enable row level security;

-- Active members can view endorsements in their group
create policy "Group members can view endorsements"
  on public.endorsements for select
  using (public.is_group_member(group_id));

-- Active members can endorse candidates
create policy "Active members can endorse"
  on public.endorsements for insert
  with check (
    auth.uid() = endorser_id
    and public.is_group_member(group_id)
  );

-- Members can remove their own endorsements
create policy "Members can unendorse"
  on public.endorsements for delete
  using (auth.uid() = endorser_id);


-- 5. TRANSACTIONS
-- from_user is nullable: NULL means currency was minted (e.g. daily income)
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  from_user uuid references public.profiles(id),       -- NULL = minted / daily income
  to_user uuid not null references public.profiles(id),
  amount numeric not null check (amount > 0),
  fee numeric not null default 0,
  memo text,
  created_at timestamptz default now()
);

alter table public.transactions enable row level security;

-- Members can view transactions in their group
create policy "Group members can view transactions"
  on public.transactions for select
  using (public.is_group_member(group_id));

-- No direct INSERT policy for transactions.
-- All transaction inserts go through SECURITY DEFINER functions: send_currency,
-- claim_daily_income. This prevents clients from forging ledger entries via the REST API.


-- 6. VOTES
create table public.votes (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  vote_type text not null check (vote_type in ('fee_rate', 'daily_income')),
  value numeric not null check (value >= 0),
  created_at timestamptz default now(),
  unique(group_id, user_id, vote_type)  -- one vote per type per member
);

alter table public.votes enable row level security;

-- Members can view votes in their group
create policy "Group members can view votes"
  on public.votes for select
  using (public.is_group_member(group_id));

-- Active members can cast votes
create policy "Active members can vote"
  on public.votes for insert
  with check (
    auth.uid() = user_id
    and public.is_group_member(group_id)
  );

-- Members can update their own votes
create policy "Members can update own votes"
  on public.votes for update
  using (auth.uid() = user_id);

-- Members can delete their own votes
create policy "Members can delete own votes"
  on public.votes for delete
  using (auth.uid() = user_id);


-- 6b. VOTE ROUNDS (voting-period window start per group + round key)
create table public.vote_rounds (
  group_id uuid not null references public.groups(id) on delete cascade,
  round_key text not null,
  opened_at timestamptz not null default now(),
  primary key (group_id, round_key)
);

alter table public.vote_rounds enable row level security;

create policy "Group members can view vote rounds"
  on public.vote_rounds for select
  using (public.is_group_member(group_id));


-- 7. SPONSORSHIPS (invite-only membership)
create table public.sponsorships (
  id uuid primary key default gen_random_uuid(),
  token text unique not null default encode(gen_random_bytes(16), 'hex'),
  group_id uuid not null references public.groups(id) on delete cascade,
  sponsor_id uuid not null references public.profiles(id),
  message text,                       -- sponsor's description of the candidate
  candidate_id uuid references public.profiles(id),  -- filled when claimed
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'expired', 'revoked')),
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '7 days')
);

alter table public.sponsorships enable row level security;

-- Sponsors can see their own sponsorships; group members can see group sponsorships
create policy "Sponsors and group members can view sponsorships"
  on public.sponsorships for select
  using (
    sponsor_id = auth.uid()
    or public.is_group_member(group_id)
  );

-- Active group members can create sponsorships
create policy "Active members can sponsor"
  on public.sponsorships for insert
  with check (
    auth.uid() = sponsor_id
    and public.is_group_member(group_id)
  );

-- Sponsors can revoke their own pending sponsorships
create policy "Sponsors can update own sponsorships"
  on public.sponsorships for update
  using (auth.uid() = sponsor_id and status = 'pending');


-- 8. AMENDMENTS (constitution changes)
create table public.amendments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  proposed_by uuid not null references public.profiles(id),
  title text not null,            -- short summary, e.g. "Rename group to XYZ"
  old_text text not null,         -- constitution at time of proposal
  new_text text not null,         -- proposed new constitution
  status text not null default 'voting'
    check (status in ('voting', 'passed', 'failed', 'withdrawn')),
  threshold numeric not null,     -- snapshot of $AMENDMENT_PERCENTAGE at proposal time (0-1)
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '7 days'),
  resolved_at timestamptz
);

alter table public.amendments enable row level security;

-- Group members can view amendments
create policy "Group members can view amendments"
  on public.amendments for select
  using (public.is_group_member(group_id));

-- Active members can propose amendments
create policy "Active members can propose amendments"
  on public.amendments for insert
  with check (
    auth.uid() = proposed_by
    and public.is_group_member(group_id)
  );

-- Proposers can withdraw their own voting amendments
create policy "Proposers can withdraw amendments"
  on public.amendments for update
  using (auth.uid() = proposed_by and status = 'voting')
  with check (true);


-- 9. AMENDMENT VOTES
create table public.amendment_votes (
  id uuid primary key default gen_random_uuid(),
  amendment_id uuid not null references public.amendments(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  vote boolean not null,          -- true = approve, false = reject
  created_at timestamptz default now(),
  unique(amendment_id, user_id)
);

alter table public.amendment_votes enable row level security;

-- Group members can view amendment votes (join through amendments to get group_id)
create policy "Members can view amendment votes"
  on public.amendment_votes for select
  using (
    exists (
      select 1 from public.amendments a
      where a.id = amendment_votes.amendment_id
        and public.is_group_member(a.group_id)
    )
  );

-- Active group members can cast a vote on an amendment
create policy "Active members can vote on amendments"
  on public.amendment_votes for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.amendments a
      where a.id = amendment_votes.amendment_id
        and a.status = 'voting'
        and public.is_group_member(a.group_id)
    )
  );

-- Members can change their vote
create policy "Members can update own amendment votes"
  on public.amendment_votes for update
  using (auth.uid() = user_id);

-- Members can remove their vote
create policy "Members can delete own amendment votes"
  on public.amendment_votes for delete
  using (auth.uid() = user_id);


-- 10. ACCORD PROPOSALS
create table public.accord_proposals (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  proposed_by uuid not null references public.profiles(id),
  text text not null check (char_length(btrim(text)) > 0 and char_length(text) <= 8000),
  status text not null default 'voting'
    check (status in ('voting', 'passed', 'failed', 'withdrawn')),
  threshold numeric not null,
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '7 days'),
  resolved_at timestamptz
);

create index idx_accord_proposals_group_status_created
  on public.accord_proposals (group_id, status, created_at desc);
create index idx_accord_proposals_group_status_resolved
  on public.accord_proposals (group_id, status, resolved_at desc);

alter table public.accord_proposals enable row level security;

create policy "Group members can view accord proposals"
  on public.accord_proposals for select
  using (public.is_group_member(group_id));

create policy "Active members can create accord proposals"
  on public.accord_proposals for insert
  with check (
    auth.uid() = proposed_by
    and public.is_group_member(group_id)
  );

create policy "Proposers can withdraw accord proposals"
  on public.accord_proposals for update
  using (auth.uid() = proposed_by and status = 'voting')
  with check (true);


-- 11. ACCORD VOTES
create table public.accord_votes (
  id uuid primary key default gen_random_uuid(),
  accord_id uuid not null references public.accord_proposals(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  vote boolean not null,
  created_at timestamptz default now(),
  unique(accord_id, user_id)
);

create index idx_accord_votes_accord on public.accord_votes (accord_id);

alter table public.accord_votes enable row level security;

create policy "Members can view accord votes"
  on public.accord_votes for select
  using (
    exists (
      select 1 from public.accord_proposals ap
      where ap.id = accord_votes.accord_id
        and public.is_group_member(ap.group_id)
    )
  );

create policy "Active members can vote on accords"
  on public.accord_votes for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.accord_proposals ap
      where ap.id = accord_votes.accord_id
        and ap.status = 'voting'
        and public.is_group_member(ap.group_id)
    )
  );

create policy "Members can update own accord votes"
  on public.accord_votes for update
  using (auth.uid() = user_id);

create policy "Members can delete own accord votes"
  on public.accord_votes for delete
  using (auth.uid() = user_id);

-- 12. GROUP EVENTS (activity log + realtime notifications)
create table public.group_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  event_type text not null,
  summary text not null,
  actor_id uuid references public.profiles(id),
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

alter table public.group_events enable row level security;

-- Group members can read events
create policy "Group members can view events"
  on public.group_events for select
  using (public.is_group_member(group_id));

-- Events are inserted by SECURITY DEFINER functions, but allow client insert
-- for amendment_proposed / accord_proposed (logged client-side via RPC)
create policy "Active members can log events"
  on public.group_events for insert
  with check (
    auth.uid() = actor_id
    and public.is_group_member(group_id)
  );

-- Emit accord_proposed group event whenever a proposal row is created.
create or replace function public.trigger_group_event_on_accord_proposal()
returns trigger as $$
declare
  v_snippet text;
  v_group_name text;
  v_subject text;
  v_html text;
  v_notify_fn regprocedure;
begin
  v_snippet := left(regexp_replace(coalesce(NEW.text, ''), '\s+', ' ', 'g'), 120);
  insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
  values (
    NEW.group_id,
    'accord_proposed',
    'Accord proposed: ' || coalesce(v_snippet, ''),
    NEW.proposed_by,
    json_build_object('accord_id', NEW.id, 'text', NEW.text)::jsonb
  );

  select name into v_group_name from public.groups where id = NEW.group_id;
  v_subject := '[' || coalesce(v_group_name, 'FairShare') || '] New proposal for accord';
  v_html := '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">'
    || '<h2 style="color:#1a5276;">New Accord Proposal</h2>'
    || '<p>Accord proposed: ' || coalesce(v_snippet, '') || '</p>'
    || '<p style="margin-top:1rem;">Log in to review and vote:</p>'
    || '<p><a href="https://app.fairshare.social/" '
    || 'style="display:inline-block;padding:0.6rem 1.2rem;background:#1a5276;color:#fff;'
    || 'border-radius:6px;text-decoration:none;font-weight:600;">Open FairShare</a></p>'
    || '<p style="font-size:0.8rem;color:#888;margin-top:2rem;">'
    || 'You are receiving this because you are a member of ' || coalesce(v_group_name, 'a FairShare group') || '. '
    || 'You can disable email notifications in your profile settings.</p>'
    || '</div>';
  v_notify_fn := to_regprocedure('public.notify_group_members(uuid,uuid,text,text,boolean)');
  if v_notify_fn is not null then
    perform public.notify_group_members(NEW.group_id, NEW.proposed_by, v_subject, v_html, p_include_actor := true);
  end if;

  return NEW;
end;
$$ language plpgsql security definer;

drop trigger if exists on_accord_proposal_group_event on public.accord_proposals;
create trigger on_accord_proposal_group_event
  after insert on public.accord_proposals
  for each row execute function public.trigger_group_event_on_accord_proposal();


-- 13. CHAT MESSAGES
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  body text not null check (char_length(body) > 0 and char_length(body) <= 2000),
  created_at timestamptz default now()
);

create index idx_chat_messages_group_time on public.chat_messages (group_id, created_at desc);

alter table public.chat_messages enable row level security;

-- Active members can read messages
create policy "Group members can read chat"
  on public.chat_messages for select
  using (public.is_group_member(group_id));

-- Active members can send messages
create policy "Active members can send chat"
  on public.chat_messages for insert
  with check (auth.uid() = user_id and public.is_group_member(group_id));


-- 14. GROUP DOCUMENTS (shared bulletin board / editable doc per group)
create table public.group_documents (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null unique references public.groups(id) on delete cascade,
  content text not null default '',
  updated_at timestamptz default now(),
  updated_by uuid references public.profiles(id)
);

alter table public.group_documents enable row level security;

-- Group members can read the document
create policy "Group members can view document"
  on public.group_documents for select
  using (public.is_group_member(group_id));

-- Insert policy for save_document SECURITY DEFINER (also allow direct insert for initial creation)
create policy "Active members can create document"
  on public.group_documents for insert
  with check (public.is_group_member(group_id));

-- Update policy for save_document SECURITY DEFINER
create policy "Active members can update document"
  on public.group_documents for update
  using (public.is_group_member(group_id));


-- 15. DOCUMENT HISTORY (revision snapshots for attribution)
create table public.document_history (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  content text not null,
  created_at timestamptz default now()
);

create index idx_document_history_group_time on public.document_history (group_id, created_at asc);

alter table public.document_history enable row level security;

-- Group members can read document history
create policy "Group members can view document history"
  on public.document_history for select
  using (public.is_group_member(group_id));

-- History rows are inserted by the save_document SECURITY DEFINER function
create policy "Active members can insert document history"
  on public.document_history for insert
  with check (public.is_group_member(group_id));


-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Look up a sponsorship by its token (bypasses RLS for invite landing page)
-- Returns sponsor name/avatar, group name, message -- safe public info only
create or replace function public.get_sponsorship_by_token(p_token text)
returns json as $$
declare
  v_record record;
begin
  select
    s.id,
    s.token,
    s.group_id,
    s.status,
    s.message,
    s.expires_at,
    p.display_name as sponsor_name,
    p.profile_image_url as sponsor_profile_image_url,
    g.name as group_name,
    g.currency_name,
    g.currency_symbol
  into v_record
  from public.sponsorships s
  join public.profiles p on p.id = s.sponsor_id
  join public.groups g on g.id = s.group_id
  where s.token = p_token;

  if not found then
    return json_build_object('error', 'Invitation not found');
  end if;

  if v_record.status != 'pending' then
    return json_build_object('error', 'This invitation has already been used');
  end if;

  if v_record.expires_at < now() then
    return json_build_object('error', 'This invitation has expired');
  end if;

  return json_build_object(
    'id', v_record.id,
    'group_id', v_record.group_id,
    'sponsor_name', v_record.sponsor_name,
    'profile_image_url', v_record.sponsor_profile_image_url,
    'group_name', v_record.group_name,
    'currency_name', v_record.currency_name,
    'currency_symbol', v_record.currency_symbol,
    'message', v_record.message
  );
end;
$$ language plpgsql security definer;


-- Claim a sponsorship: validate token, create pending member, auto-endorse from sponsor
create or replace function public.claim_sponsorship(p_token text)
returns json as $$
declare
  v_user_id uuid := auth.uid();
  v_sponsorship record;
begin
  if v_user_id is null then
    raise exception 'You must be logged in to claim a sponsorship';
  end if;

  -- Lock the row to prevent double-claim
  select * into v_sponsorship
  from public.sponsorships
  where token = p_token
  for update;

  if not found then
    raise exception 'Invitation not found';
  end if;

  if v_sponsorship.status != 'pending' then
    raise exception 'This invitation has already been used';
  end if;

  if v_sponsorship.expires_at < now() then
    -- Mark as expired
    update public.sponsorships set status = 'expired' where id = v_sponsorship.id;
    raise exception 'This invitation has expired';
  end if;

  -- Check user isn't already a member (active or pending)
  if exists (
    select 1 from public.members
    where group_id = v_sponsorship.group_id
      and user_id = v_user_id
      and status in ('active', 'pending')
  ) then
    raise exception 'You are already a member or pending candidate of this group';
  end if;

  -- Mark sponsorship as claimed
  update public.sponsorships
  set candidate_id = v_user_id, status = 'claimed'
  where id = v_sponsorship.id;

  -- Create pending membership
  insert into public.members (group_id, user_id, status, balance)
  values (v_sponsorship.group_id, v_user_id, 'pending', 0);

  -- Log member_sponsored event
  insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
  values (
    v_sponsorship.group_id,
    'member_sponsored',
    'New candidate '
      || (select display_name from public.profiles where id = v_user_id)
      || ', sponsored by '
      || (select display_name from public.profiles where id = v_sponsorship.sponsor_id),
    v_sponsorship.sponsor_id,
    json_build_object('sponsor_id', v_sponsorship.sponsor_id, 'candidate_id', v_user_id)::jsonb
  );

  -- Auto-endorse from the sponsor
  insert into public.endorsements (group_id, candidate_id, endorser_id)
  values (v_sponsorship.group_id, v_user_id, v_sponsorship.sponsor_id);

  -- If the candidate has no sponsor yet, set the group sponsor as their profile sponsor
  if not exists (
    select 1 from public.profiles
    where id = v_user_id and sponsor_id is not null
  ) then
    update public.profiles
    set sponsor_id = v_sponsorship.sponsor_id
    where id = v_user_id;
  end if;

  -- Sponsor ↔ candidate as contacts (same pattern as complete_meet)
  if v_sponsorship.sponsor_id <> v_user_id then
    insert into public.contacts (user_id, contact_id, met_at)
    values (v_sponsorship.sponsor_id, v_user_id, now())
    on conflict (user_id, contact_id) do update set met_at = now();

    insert into public.contacts (user_id, contact_id, met_at)
    values (v_user_id, v_sponsorship.sponsor_id, now())
    on conflict (user_id, contact_id) do update set met_at = now();
  end if;

  -- Immediately check if this endorsement meets the threshold
  perform public.check_endorsements(v_sponsorship.group_id, v_user_id);

  -- Return result; check if candidate was admitted
  return json_build_object(
    'success', true,
    'group_id', v_sponsorship.group_id,
    'group_name', (select name from public.groups where id = v_sponsorship.group_id),
    'admitted', (select status = 'active' from public.members
                 where group_id = v_sponsorship.group_id and user_id = v_user_id)
  );
end;
$$ language plpgsql security definer;

-- Send currency from one member to another within a group
create or replace function public.send_currency(
  p_group_id uuid,
  p_to_user uuid,
  p_amount numeric,
  p_memo text default null
)
returns json as $$
declare
  v_from_user uuid := auth.uid();
  v_fee_rate numeric;
  v_fee numeric;
  v_net numeric;
  v_sender_balance numeric;
begin
  -- Get the group's fee rate
  select fee_rate into v_fee_rate from public.groups where id = p_group_id;
  if not found then
    raise exception 'Group not found';
  end if;

  -- Calculate fee
  v_fee := p_amount * v_fee_rate;
  v_net := p_amount - v_fee;

  -- Check sender is active member with sufficient balance
  select balance into v_sender_balance
  from public.members
  where group_id = p_group_id and user_id = v_from_user and status = 'active';

  if not found then
    raise exception 'You are not an active member of this group';
  end if;

  if v_sender_balance < p_amount then
    raise exception 'Insufficient balance';
  end if;

  -- Check recipient is active member
  if not exists (
    select 1 from public.members
    where group_id = p_group_id and user_id = p_to_user and status = 'active'
  ) then
    raise exception 'Recipient is not an active member of this group';
  end if;

  -- Deduct from sender
  update public.members
  set balance = balance - p_amount
  where group_id = p_group_id and user_id = v_from_user;

  -- Add net amount to recipient
  update public.members
  set balance = balance + v_net
  where group_id = p_group_id and user_id = p_to_user;

  -- The fee is destroyed (reduces money supply) -- or could go to a group fund
  -- For now, fee simply disappears from circulation

  -- Record the transaction
  insert into public.transactions (group_id, from_user, to_user, amount, fee, memo)
  values (p_group_id, v_from_user, p_to_user, p_amount, v_fee, p_memo);

  -- Log event so the recipient gets a realtime notification
  insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
  values (
    p_group_id,
    'payment_received',
    (select display_name from public.profiles where id = v_from_user)
      || ' sent '
      || (select currency_symbol from public.groups where id = p_group_id)
      || ' ' || round(v_net, 2) || ' to '
      || (select display_name from public.profiles where id = p_to_user),
    v_from_user,
    json_build_object('from_user', v_from_user, 'to_user', p_to_user,
      'amount', p_amount, 'fee', v_fee, 'net', v_net)::jsonb
  );

  return json_build_object(
    'success', true,
    'amount', p_amount,
    'fee', v_fee,
    'net', v_net
  );
end;
$$ language plpgsql security definer;


-- Parse $VOTING_PERIOD_DAYS from constitution (null = full active membership basis)
create or replace function public.get_voting_period_days(p_constitution text)
returns int as $$
declare
  v_match text[];
begin
  if p_constitution is null then
    return null;
  end if;
  v_match := regexp_match(p_constitution, '(\d+)\s*days?\s*\$VOTING_PERIOD_DAYS', 'i');
  if v_match is not null and v_match[1]::int > 0 then
    return v_match[1]::int;
  end if;
  return null;
end;
$$ language plpgsql immutable;


-- Check endorsements and admit candidate if threshold met
-- Reads $NEW_MEMBER_PERCENTAGE from group constitution (default 100%)
create or replace function public.check_endorsements(
  p_group_id uuid,
  p_candidate_id uuid
)
returns json as $$
declare
  v_active_count int;
  v_endorsement_count int;
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
begin
  -- Count active members
  select count(*) into v_active_count
  from public.members
  where group_id = p_group_id and status = 'active';

  -- Read threshold from constitution ($NEW_MEMBER_PERCENTAGE), default 100%
  select constitution into v_constitution
  from public.groups
  where id = p_group_id;

  v_pct := 1.0; -- default 100%
  if v_constitution is not null then
    v_pct_match := regexp_match(v_constitution, ':\s*(\d+)%\s*(?:members?\s*)?\$NEW_MEMBER_PERCENTAGE');
    if v_pct_match is not null then
      v_pct := v_pct_match[1]::numeric / 100.0;
    end if;
  end if;

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

    select count(*) into v_endorsement_count
    from public.endorsements
    where group_id = p_group_id
      and candidate_id = p_candidate_id
      and created_at >= v_opened_at
      and created_at < v_window_end;

    select count(distinct endorser_id) into v_participants
    from public.endorsements
    where group_id = p_group_id
      and candidate_id = p_candidate_id
      and created_at >= v_opened_at
      and created_at < v_window_end;

    if now() >= v_window_end then
      -- Voting period expired: threshold from those who actually voted
      v_threshold := greatest(1, ceil(v_participants * v_pct));
    else
      -- Voting period still open: only admit early if all active members endorsed
      v_threshold := greatest(1, ceil(v_active_count * v_pct));
    end if;
  else
    select count(*) into v_endorsement_count
    from public.endorsements
    where group_id = p_group_id and candidate_id = p_candidate_id;

    v_participants := null;
    v_threshold := greatest(1, ceil(v_active_count * v_pct));
  end if;

  if v_endorsement_count >= v_threshold then
    -- Admit the candidate
    update public.members
    set status = 'active', joined_at = now()
    where group_id = p_group_id and user_id = p_candidate_id and status = 'pending';

    -- Clean up endorsements and voting round
    delete from public.endorsements
    where group_id = p_group_id and candidate_id = p_candidate_id;

    if v_period_days is not null and v_period_days > 0 then
      delete from public.vote_rounds
      where group_id = p_group_id and round_key = v_round_key;
    end if;

    -- Look up the sponsor's name
    select p.display_name into v_sponsor_name
    from public.sponsorships s
    join public.profiles p on p.id = s.sponsor_id
    where s.group_id = p_group_id
      and s.candidate_id = p_candidate_id
      and s.status = 'claimed'
    limit 1;

    -- Log member_joined event
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
      'threshold', v_threshold,
      'participants', v_participants,
      'voting_period', v_period_days is not null
    );
  end if;

  return json_build_object(
    'admitted', false,
    'endorsements', v_endorsement_count,
    'threshold', v_threshold,
    'participants', v_participants,
    'voting_period', v_period_days is not null
  );
end;
$$ language plpgsql security definer;


-- Compute tally (median) of votes and update group settings
-- Reads $CHANGE_CURRENCY_RATES_PERCENTAGE from constitution (default 66%)
-- Full population: quorum = % of active members who voted
-- Voting period: quorum = % of participants who voted in the round window
create or replace function public.compute_tally(
  p_group_id uuid,
  p_vote_type text,
  p_finalize boolean default false
)
returns json as $$
declare
  v_median numeric;
  v_vote_count int;
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
  v_expired boolean;
  v_should_apply boolean;
begin
  select constitution into v_constitution
  from public.groups
  where id = p_group_id;

  v_period_days := public.get_voting_period_days(v_constitution);

  if v_period_days is not null then
    insert into public.vote_rounds (group_id, round_key, opened_at)
    values (p_group_id, p_vote_type, now())
    on conflict do nothing;

    select opened_at into v_opened_at
    from public.vote_rounds
    where group_id = p_group_id and round_key = p_vote_type;

    v_window_end := v_opened_at + (v_period_days || ' days')::interval;
    v_expired := now() >= v_window_end;

    if p_finalize and not v_expired then
      return json_build_object(
        'median', 0,
        'vote_count', 0,
        'applied', false,
        'reason', 'Voting period not expired'
      );
    end if;

    select count(*) into v_vote_count
    from public.votes
    where group_id = p_group_id
      and vote_type = p_vote_type
      and created_at >= v_opened_at
      and created_at < v_window_end;

    if v_vote_count = 0 then
      if p_finalize and v_expired then
        delete from public.vote_rounds
        where group_id = p_group_id and round_key = p_vote_type;
      end if;
      return json_build_object('median', 0, 'vote_count', 0, 'applied', false, 'reason', 'No votes cast');
    end if;

    v_participants := v_vote_count;
  else
    select count(*) into v_vote_count
    from public.votes
    where group_id = p_group_id and vote_type = p_vote_type;

    if v_vote_count = 0 then
      return json_build_object('median', 0, 'vote_count', 0, 'applied', false, 'reason', 'No votes cast');
    end if;

    v_participants := null;
    v_expired := false;
  end if;

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

  if v_period_days is not null then
    v_threshold := greatest(1, ceil(v_participants * v_pct));
  else
    v_threshold := greatest(1, ceil(v_active_count * v_pct));
  end if;

  v_should_apply := v_vote_count >= v_threshold;

  if v_should_apply and (v_period_days is null or not v_expired or p_finalize) then
    if v_period_days is not null then
      select percentile_cont(0.5) within group (order by value)
      into v_median
      from public.votes
      where group_id = p_group_id
        and vote_type = p_vote_type
        and created_at >= v_opened_at
        and created_at < v_window_end;
    else
      select percentile_cont(0.5) within group (order by value)
      into v_median
      from public.votes
      where group_id = p_group_id and vote_type = p_vote_type;
    end if;

    if p_vote_type = 'fee_rate' then
      update public.groups set fee_rate = v_median where id = p_group_id;
    elsif p_vote_type = 'daily_income' then
      update public.groups set daily_income = v_median where id = p_group_id;
    end if;

    delete from public.votes
    where group_id = p_group_id and vote_type = p_vote_type;

    delete from public.vote_rounds
    where group_id = p_group_id and round_key = p_vote_type;

    insert into public.group_events (group_id, event_type, summary, metadata)
    values (
      p_group_id,
      'rate_change',
      case p_vote_type
        when 'fee_rate' then 'Fee rate changed to ' || round(v_median * 100, 1) || '%'
        when 'daily_income' then 'Daily income changed to ' || round(v_median, 2)
        else 'Rate changed'
      end,
      json_build_object('vote_type', p_vote_type, 'new_value', v_median, 'vote_count', v_vote_count)::jsonb
    );

    v_applied := true;
  elsif v_period_days is not null and v_expired and p_finalize then
    select percentile_cont(0.5) within group (order by value)
    into v_median
    from public.votes
    where group_id = p_group_id
      and vote_type = p_vote_type
      and created_at >= v_opened_at
      and created_at < v_window_end;

    delete from public.votes
    where group_id = p_group_id and vote_type = p_vote_type;

    delete from public.vote_rounds
    where group_id = p_group_id and round_key = p_vote_type;

    v_median := coalesce(v_median, 0);
  else
    if v_period_days is not null then
      select percentile_cont(0.5) within group (order by value)
      into v_median
      from public.votes
      where group_id = p_group_id
        and vote_type = p_vote_type
        and created_at >= v_opened_at
        and created_at < v_window_end;
    else
      select percentile_cont(0.5) within group (order by value)
      into v_median
      from public.votes
      where group_id = p_group_id and vote_type = p_vote_type;
    end if;
  end if;

  return json_build_object(
    'median', coalesce(v_median, 0),
    'vote_count', v_vote_count,
    'active_members', v_active_count,
    'participants', v_participants,
    'threshold', v_threshold,
    'applied', v_applied,
    'voting_period', v_period_days is not null,
    'expired', v_expired
  );
end;
$$ language plpgsql security definer;


-- Claim daily income for the calling user in a group
-- Only succeeds if 24+ hours since last claim (or never claimed)
create or replace function public.claim_daily_income(p_group_id uuid)
returns json as $$
declare
  v_user_id uuid := auth.uid();
  v_daily_income numeric;
  v_last_income timestamptz;
  v_balance numeric;
begin
  -- Get the group's daily income setting
  select daily_income into v_daily_income
  from public.groups where id = p_group_id;

  if v_daily_income is null or v_daily_income <= 0 then
    return json_build_object('claimed', false, 'reason', 'No daily income set for this group');
  end if;

  -- Get the member's last income timestamp and current balance
  select last_income_at, balance into v_last_income, v_balance
  from public.members
  where group_id = p_group_id and user_id = v_user_id and status = 'active';

  if not found then
    return json_build_object('claimed', false, 'reason', 'Not an active member');
  end if;

  -- Check if 24 hours have passed since last claim
  if v_last_income is not null and v_last_income > now() - interval '24 hours' then
    return json_build_object('claimed', false, 'reason', 'Too soon',
      'next_claim_at', v_last_income + interval '24 hours');
  end if;

  -- Update balance and last_income_at
  update public.members
  set balance = balance + v_daily_income,
      last_income_at = now()
  where group_id = p_group_id and user_id = v_user_id and status = 'active';

  -- Record the minting transaction (from_user = NULL means minted)
  insert into public.transactions (group_id, from_user, to_user, amount, fee, memo)
  values (p_group_id, null, v_user_id, v_daily_income, 0, 'Daily income');

  return json_build_object(
    'claimed', true,
    'amount', v_daily_income,
    'new_balance', v_balance + v_daily_income
  );
end;
$$ language plpgsql security definer;


-- Resolve an amendment: either early (threshold already met) or after voting expires
-- Full population: approvals / active members
-- Voting period: approvals / (approvals + rejections) among votes in the period
create or replace function public.resolve_amendment(p_amendment_id uuid)
returns json as $$
declare
  v_amendment record;
  v_active_count int;
  v_approve_count int;
  v_reject_count int;
  v_voter_count int;
  v_ratio numeric;
  v_passed boolean;
  v_tag text;
  v_value text;
  v_parts record;
  v_constitution text;
  v_period_days int;
  v_window_end timestamptz;
begin
  -- Fetch the amendment
  select * into v_amendment
  from public.amendments
  where id = p_amendment_id
  for update;

  if not found then
    raise exception 'Amendment not found';
  end if;

  if v_amendment.status != 'voting' then
    raise exception 'Amendment is not in voting status';
  end if;

  -- Verify caller is an active member of this group
  if not public.is_group_member(v_amendment.group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  select count(*) into v_active_count
  from public.members
  where group_id = v_amendment.group_id and status = 'active';

  select constitution into v_constitution
  from public.groups
  where id = v_amendment.group_id;

  v_period_days := public.get_voting_period_days(v_constitution);
  v_window_end := v_amendment.created_at + coalesce(v_period_days, 7) * interval '1 day';

  if v_period_days is not null then
    select count(*) into v_approve_count
    from public.amendment_votes
    where amendment_id = p_amendment_id
      and vote = true
      and created_at >= v_amendment.created_at
      and created_at < v_window_end;

    select count(*) into v_reject_count
    from public.amendment_votes
    where amendment_id = p_amendment_id
      and vote = false
      and created_at >= v_amendment.created_at
      and created_at < v_window_end;

    v_voter_count := v_approve_count + v_reject_count;

    if v_voter_count = 0 then
      v_ratio := 0;
    else
      v_ratio := v_approve_count::numeric / v_voter_count::numeric;
    end if;
  else
    select count(*) into v_approve_count
    from public.amendment_votes
    where amendment_id = p_amendment_id and vote = true;

    v_reject_count := 0;
    v_voter_count := null;

    if v_active_count = 0 then
      v_ratio := 0;
    else
      v_ratio := v_approve_count::numeric / v_active_count::numeric;
    end if;
  end if;

  v_passed := v_ratio >= v_amendment.threshold;

  if not v_passed and v_amendment.expires_at > now() then
    return json_build_object(
      'resolved', false,
      'approve_count', v_approve_count,
      'reject_count', v_reject_count,
      'voter_count', v_voter_count,
      'active_members', v_active_count,
      'ratio', round(v_ratio * 100, 1),
      'threshold', round(v_amendment.threshold * 100, 1),
      'voting_period', v_period_days is not null
    );
  end if;

  if v_passed then
    -- Update the constitution
    update public.groups
    set constitution = v_amendment.new_text
    where id = v_amendment.group_id;

    -- Parse tagged variables from new_text and apply changes
    -- Tags appear as $TAG_NAME anywhere in the text (not necessarily at end of line)
    -- The value is everything between the nearest preceding colon and the $TAG
    for v_parts in
      select (m)[1] as val, (m)[2] as tag
      from regexp_matches(v_amendment.new_text, ':\s*([^:]*?)\s*\$([A-Z_]+)', 'g') as m
    loop
      v_value := v_parts.val;
      v_tag := v_parts.tag;

      case v_tag
        when 'GROUP_NAME' then
          update public.groups set name = v_value where id = v_amendment.group_id;
        when 'CURRENCY_NAME' then
          update public.groups set currency_name = v_value where id = v_amendment.group_id;
        when 'CURRENCY_SYMBOL' then
          update public.groups set currency_symbol = v_value where id = v_amendment.group_id;
        -- AMENDMENT_PERCENTAGE, NEW_MEMBER_PERCENTAGE, and
        -- CHANGE_CURRENCY_RATES_PERCENTAGE are read from constitution text
        -- at runtime, no separate column to update
        else
          null;
      end case;
    end loop;

    -- Mark as passed
    update public.amendments
    set status = 'passed', resolved_at = now()
    where id = p_amendment_id;

    -- Log amendment_passed event
    insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
    values (
      v_amendment.group_id,
      'amendment_passed',
      'Amendment passed: ' || v_amendment.title,
      v_amendment.proposed_by,
      json_build_object('amendment_id', p_amendment_id, 'title', v_amendment.title,
        'approve_count', v_approve_count, 'active_members', v_active_count)::jsonb
    );
  else
    -- Mark as failed
    update public.amendments
    set status = 'failed', resolved_at = now()
    where id = p_amendment_id;

    -- Log amendment_failed event
    insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
    values (
      v_amendment.group_id,
      'amendment_failed',
      'Amendment failed: ' || v_amendment.title,
      v_amendment.proposed_by,
      json_build_object('amendment_id', p_amendment_id, 'title', v_amendment.title,
        'approve_count', v_approve_count, 'active_members', v_active_count)::jsonb
    );
  end if;

  return json_build_object(
    'passed', v_passed,
    'approve_count', v_approve_count,
    'reject_count', v_reject_count,
    'voter_count', v_voter_count,
    'active_members', v_active_count,
    'ratio', round(v_ratio * 100, 1),
    'threshold', round(v_amendment.threshold * 100, 1),
    'voting_period', v_period_days is not null
  );
end;
$$ language plpgsql security definer;


-- Resolve an accord proposal: either early (threshold already met) or after voting expires
-- Full population: approvals / active members
-- Voting period: approvals / (approvals + rejections) among votes in the period
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

  v_period_days := public.get_voting_period_days(v_constitution);
  v_window_end := v_accord.created_at + coalesce(v_period_days, 7) * interval '1 day';

  if v_period_days is not null then
    select count(*) into v_approve_count
    from public.accord_votes
    where accord_id = p_accord_id
      and vote = true
      and created_at >= v_accord.created_at
      and created_at < v_window_end;

    select count(*) into v_reject_count
    from public.accord_votes
    where accord_id = p_accord_id
      and vote = false
      and created_at >= v_accord.created_at
      and created_at < v_window_end;

    v_voter_count := v_approve_count + v_reject_count;
    if v_voter_count = 0 then
      v_ratio := 0;
    else
      v_ratio := v_approve_count::numeric / v_voter_count::numeric;
    end if;
  else
    select count(*) into v_approve_count
    from public.accord_votes
    where accord_id = p_accord_id and vote = true;

    v_reject_count := 0;
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
      'voting_period', v_period_days is not null
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
        'active_members', v_active_count
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
        'active_members', v_active_count
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
    'voting_period', v_period_days is not null
  );
end;
$$ language plpgsql security definer;


-- Finalize voting rounds that have passed their constitution voting period (client-triggered)
create or replace function public.finalize_expired_voting(p_group_id uuid)
returns json as $$
declare
  v_constitution text;
  v_period_days int;
  v_round record;
  v_amendment record;
  v_accord record;
  v_amendment_ids uuid[] := '{}';
  v_accord_ids uuid[] := '{}';
  v_currency_rounds text[] := '{}';
  v_candidate_ids uuid[] := '{}';
  v_candidate_id uuid;
begin
  select constitution into v_constitution
  from public.groups
  where id = p_group_id;

  v_period_days := public.get_voting_period_days(v_constitution);

  if v_period_days is null then
    return json_build_object('finalized', false, 'reason', 'full_population_mode');
  end if;

  for v_round in
    select round_key
    from public.vote_rounds
    where group_id = p_group_id
      and round_key in ('fee_rate', 'daily_income')
      and opened_at + (v_period_days || ' days')::interval <= now()
  loop
    perform public.compute_tally(p_group_id, v_round.round_key, true);
    delete from public.vote_rounds
    where group_id = p_group_id and round_key = v_round.round_key;
    v_currency_rounds := array_append(v_currency_rounds, v_round.round_key);
  end loop;

  for v_amendment in
    select id
    from public.amendments
    where group_id = p_group_id
      and status = 'voting'
      and expires_at <= now()
  loop
    perform public.resolve_amendment(v_amendment.id);
    v_amendment_ids := array_append(v_amendment_ids, v_amendment.id);
  end loop;

  for v_accord in
    select id
    from public.accord_proposals
    where group_id = p_group_id
      and status = 'voting'
      and expires_at <= now()
  loop
    perform public.resolve_accord(v_accord.id);
    v_accord_ids := array_append(v_accord_ids, v_accord.id);
  end loop;

  for v_round in
    select round_key
    from public.vote_rounds
    where group_id = p_group_id
      and round_key like 'candidate:%'
      and opened_at + (v_period_days || ' days')::interval <= now()
  loop
    v_candidate_id := substring(v_round.round_key from 11)::uuid;
    perform public.check_endorsements(p_group_id, v_candidate_id);
    v_candidate_ids := array_append(v_candidate_ids, v_candidate_id);
  end loop;

  -- Also handle pending candidates that have endorsements but no vote_rounds row
  -- (e.g. sponsored before the voting-period function was deployed)
  for v_candidate_id in
    select m.user_id
    from public.members m
    where m.group_id = p_group_id
      and m.status = 'pending'
      and not exists (
        select 1 from public.vote_rounds vr
        where vr.group_id = p_group_id
          and vr.round_key = 'candidate:' || m.user_id::text
      )
      and exists (
        select 1 from public.endorsements e
        where e.group_id = p_group_id
          and e.candidate_id = m.user_id
      )
  loop
    perform public.check_endorsements(p_group_id, v_candidate_id);
    v_candidate_ids := array_append(v_candidate_ids, v_candidate_id);
  end loop;

  return json_build_object(
    'finalized', true,
    'currency_rounds', to_json(v_currency_rounds),
    'amendments', to_json(v_amendment_ids),
    'accords', to_json(v_accord_ids),
    'candidates', to_json(v_candidate_ids)
  );
end;
$$ language plpgsql security definer;


-- ============================================================
-- EMAIL NOTIFICATIONS (Resend via pg_net)
-- Requires: pg_net extension enabled, vault extension enabled,
-- Resend API key stored in vault with name 'resend_api_key':
--   SELECT vault.create_secret('re_YOUR_KEY_HERE', 'resend_api_key');
-- ============================================================

-- Low-level helper: send a single email via Resend HTTP API.
-- Runs asynchronously (fire-and-forget) via pg_net.
create or replace function public.send_email(
  p_to text,
  p_subject text,
  p_html text
)
returns void as $$
declare
  v_api_key text;
  v_from text := 'FairShare <notifications@fairshare.social>';
begin
  -- Read the Resend API key from Supabase Vault
  select decrypted_secret into v_api_key
  from vault.decrypted_secrets
  where name = 'resend_api_key'
  limit 1;

  if v_api_key is null then
    raise warning 'send_email: Resend API key not found in vault — skipping email to %', p_to;
    return;
  end if;

  -- Fire-and-forget HTTP POST to Resend
  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_api_key,
      'Content-Type',  'application/json'
    ),
    body    := jsonb_build_object(
      'from',    v_from,
      'to',      p_to,
      'subject', p_subject,
      'html',    p_html
    )
  );
end;
$$ language plpgsql security definer;


-- Notify active members of a group via email.
-- By default excludes the actor; pass p_include_actor := true to include them.
-- Respects the email_notifications preference on profiles.
create or replace function public.notify_group_members(
  p_group_id uuid,
  p_actor_id uuid,
  p_subject text,
  p_html text,
  p_include_actor boolean default false
)
returns void as $$
declare
  v_recipient record;
begin
  for v_recipient in
    select u.email
    from public.members m
    join public.profiles p on p.id = m.user_id
    join auth.users u on u.id = m.user_id
    where m.group_id = p_group_id
      and m.status = 'active'
      and (p_include_actor or m.user_id <> p_actor_id)
      and (p.email_notifications is null or p.email_notifications = true)
      and u.email is not null
  loop
    perform public.send_email(v_recipient.email, p_subject, p_html);
  end loop;
end;
$$ language plpgsql security definer;


-- Save group document: upserts current content and appends a history snapshot.
-- Only active members can save.
create or replace function public.save_document(
  p_group_id uuid,
  p_content text
)
returns json as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'You must be logged in';
  end if;

  if not public.is_group_member(p_group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  -- Upsert the current document
  insert into public.group_documents (group_id, content, updated_at, updated_by)
  values (p_group_id, p_content, now(), v_user_id)
  on conflict (group_id)
  do update set content = excluded.content,
               updated_at = excluded.updated_at,
               updated_by = excluded.updated_by;

  -- Append a history snapshot
  insert into public.document_history (group_id, user_id, content)
  values (p_group_id, v_user_id, p_content);

  return json_build_object('success', true);
end;
$$ language plpgsql security definer;


-- Log a group event from the client (for events not triggered by DEFINER functions).
-- Also dispatches email notifications for specific event types.
create or replace function public.log_group_event(
  p_group_id uuid,
  p_event_type text,
  p_summary text,
  p_metadata jsonb default '{}'
)
returns void as $$
declare
  v_actor_id uuid := auth.uid();
  v_group_name text;
  v_subject text;
  v_html text;
  v_title text;
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  -- Insert the event row (for Realtime + activity log)
  insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
  values (p_group_id, p_event_type, p_summary, v_actor_id, p_metadata);

  -- Dispatch email notifications for specific event types
  case p_event_type
    when 'amendment_proposed' then
      select name into v_group_name from public.groups where id = p_group_id;
      v_title := coalesce(p_metadata->>'title', 'Untitled');
      v_subject := '[' || coalesce(v_group_name, 'FairShare') || '] Amendment proposed: ' || v_title;
      v_html := '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">'
        || '<h2 style="color:#1a5276;">New Amendment Proposed</h2>'
        || '<p>' || p_summary || '</p>'
        || '<p style="margin-top:1rem;">Log in to review and vote:</p>'
        || '<p><a href="https://app.fairshare.social/" '
        || 'style="display:inline-block;padding:0.6rem 1.2rem;background:#1a5276;color:#fff;'
        || 'border-radius:6px;text-decoration:none;font-weight:600;">Open FairShare</a></p>'
        || '<p style="font-size:0.8rem;color:#888;margin-top:2rem;">'
        || 'You are receiving this because you are a member of ' || coalesce(v_group_name, 'a FairShare group') || '. '
        || 'You can disable email notifications in your profile settings.</p>'
        || '</div>';
      perform public.notify_group_members(p_group_id, v_actor_id, v_subject, v_html, p_include_actor := true);

    when 'accord_proposed' then
      select name into v_group_name from public.groups where id = p_group_id;
      v_subject := '[' || coalesce(v_group_name, 'FairShare') || '] New proposal for accord';
      v_html := '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">'
        || '<h2 style="color:#1a5276;">New Accord Proposal</h2>'
        || '<p>' || p_summary || '</p>'
        || '<p style="margin-top:1rem;">Log in to review and vote:</p>'
        || '<p><a href="https://app.fairshare.social/" '
        || 'style="display:inline-block;padding:0.6rem 1.2rem;background:#1a5276;color:#fff;'
        || 'border-radius:6px;text-decoration:none;font-weight:600;">Open FairShare</a></p>'
        || '<p style="font-size:0.8rem;color:#888;margin-top:2rem;">'
        || 'You are receiving this because you are a member of ' || coalesce(v_group_name, 'a FairShare group') || '. '
        || 'You can disable email notifications in your profile settings.</p>'
        || '</div>';
      perform public.notify_group_members(p_group_id, v_actor_id, v_subject, v_html, p_include_actor := true);

    -- Future: add more WHEN clauses here for other event types
    -- when 'member_sponsored' then ...
    -- when 'rate_change_applied' then ...
    else
      null;  -- no email for other event types yet
  end case;
end;
$$ language plpgsql security definer;

-- Update a group's logo URL (active members only) and log activity.
create or replace function public.update_group_logo(
  p_group_id uuid,
  p_logo_url text
)
returns json as $$
declare
  v_actor_id uuid := auth.uid();
  v_display_name text;
  v_logo_updated_at timestamptz;
begin
  if v_actor_id is null then
    raise exception 'You must be logged in';
  end if;

  if p_logo_url is null or btrim(p_logo_url) = '' then
    raise exception 'Logo URL is required';
  end if;

  if not public.is_group_member(p_group_id) then
    raise exception 'You are not an active member of this group';
  end if;

  update public.groups
  set logo_url = p_logo_url,
      logo_updated_at = now()
  where id = p_group_id
  returning logo_updated_at into v_logo_updated_at;

  if not found then
    raise exception 'Group not found';
  end if;

  select display_name into v_display_name
  from public.profiles
  where id = v_actor_id;

  insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
  values (
    p_group_id,
    'group_logo_changed',
    coalesce(v_display_name, 'Someone') || ' changed the group logo',
    v_actor_id,
    json_build_object('logo_url', p_logo_url, 'logo_updated_at', v_logo_updated_at)::jsonb
  );

  return json_build_object(
    'success', true,
    'logo_url', p_logo_url,
    'logo_updated_at', v_logo_updated_at
  );
end;
$$ language plpgsql security definer;


-- Leave a group: set own membership to 'removed' and log the event.
create or replace function public.leave_group(p_group_id uuid)
returns void as $$
declare
  v_user_id uuid := auth.uid();
  v_display_name text;
begin
  if v_user_id is null then
    raise exception 'You must be logged in';
  end if;

  if not exists (
    select 1 from public.members
    where group_id = p_group_id and user_id = v_user_id and status in ('active', 'pending')
  ) then
    raise exception 'You are not a member of this group';
  end if;

  select display_name into v_display_name
  from public.profiles where id = v_user_id;

  insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
  values (
    p_group_id,
    'member_left',
    coalesce(v_display_name, 'Someone') || ' has left group',
    v_user_id,
    '{}'::jsonb
  );

  update public.members
  set status = 'removed'
  where group_id = p_group_id and user_id = v_user_id;
end;
$$ language plpgsql security definer;


-- ============================================================
-- MEET REQUESTS (short-lived tokens for in-person QR exchange)
-- ============================================================
create table public.meet_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text unique not null default encode(gen_random_bytes(16), 'hex'),
  share_phone boolean not null default false,
  share_email boolean not null default false,
  group_id uuid references public.groups(id) on delete set null,
  message text,
  created_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '24 hours')
);

alter table public.meet_requests enable row level security;

-- Users can insert their own meet requests
create policy "Users can insert own meet requests"
  on public.meet_requests for insert
  with check (auth.uid() = user_id);

-- Users can read their own meet requests
create policy "Users can read own meet requests"
  on public.meet_requests for select
  using (auth.uid() = user_id);

-- Users can update their own meet requests (e.g. toggle share_phone/share_email)
create policy "Users can update own meet requests"
  on public.meet_requests for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Users can delete their own meet requests
create policy "Users can delete own meet requests"
  on public.meet_requests for delete
  using (auth.uid() = user_id);


-- ============================================================
-- CONTACTS (permanent record of in-person meetings)
-- ============================================================
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid not null references public.profiles(id) on delete cascade,
  met_at timestamptz default now(),
  unique(user_id, contact_id)
);

alter table public.contacts enable row level security;

-- Users can read their own contacts
create policy "Users can read own contacts"
  on public.contacts for select
  using (auth.uid() = user_id);

-- Enable Realtime on contacts table so the other phone gets notified
alter publication supabase_realtime add table public.contacts;

-- Need FULL replica identity so Realtime UPDATE events include all columns
-- (required for filter: 'user_id=eq.X' to work on UPDATEs, not just INSERTs)
alter table public.contacts replica identity full;

-- Enable Realtime for group chat, activity log, and document history
alter publication supabase_realtime add table public.chat_messages;
alter publication supabase_realtime add table public.group_events;
alter publication supabase_realtime add table public.document_history;

-- Enable Realtime for contact notifications (profile picture suggestions, etc.)
alter publication supabase_realtime add table public.contact_notifications;


-- ============================================================
-- COMPLETE MEET: server-side function for QR contact exchange
-- ============================================================
create or replace function public.complete_meet(p_token text)
returns json as $$
declare
  v_caller_id uuid := auth.uid();
  v_meet_request record;
  v_contact_name text;
  v_group_name text;
  v_admitted boolean;
begin
  -- Look up the meet request by token, locking the row so a concurrent
  -- call cannot race past the checks before we finish.
  select * into v_meet_request
  from public.meet_requests
  where token = p_token
    and expires_at > now()
  for update;

  if not found then
    raise exception 'Meet request not found or expired';
  end if;

  -- Cannot meet yourself
  if v_meet_request.user_id = v_caller_id then
    raise exception 'Cannot create a contact with yourself';
  end if;

  -- Insert bidirectional contacts, or update met_at ("Last Seen") if already exist
  insert into public.contacts (user_id, contact_id, met_at)
  values (v_caller_id, v_meet_request.user_id, now())
  on conflict (user_id, contact_id) do update set met_at = now();

  insert into public.contacts (user_id, contact_id, met_at)
  values (v_meet_request.user_id, v_caller_id, now())
  on conflict (user_id, contact_id) do update set met_at = now();

  -- Get the other person's display name
  select display_name into v_contact_name
  from public.profiles
  where id = v_meet_request.user_id;

  -- If this meet carries group context, also perform sponsorship
  if v_meet_request.group_id is not null then

    -- Check caller isn't already a member (active or pending)
    if exists (
      select 1 from public.members
      where group_id = v_meet_request.group_id
        and user_id = v_caller_id
        and status in ('active', 'pending')
    ) then
      raise exception 'You are already a member or pending candidate of this group';
    end if;

    -- Create pending membership
    insert into public.members (group_id, user_id, status, balance)
    values (v_meet_request.group_id, v_caller_id, 'pending', 0);

    -- Log member_sponsored event
    insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
    values (
      v_meet_request.group_id,
      'member_sponsored',
      'New candidate '
        || (select display_name from public.profiles where id = v_caller_id)
        || ', sponsored by '
        || coalesce(v_contact_name, 'Unknown'),
      v_meet_request.user_id,
      json_build_object('sponsor_id', v_meet_request.user_id, 'candidate_id', v_caller_id)::jsonb
    );

    -- Auto-endorse from the sponsor
    insert into public.endorsements (group_id, candidate_id, endorser_id)
    values (v_meet_request.group_id, v_caller_id, v_meet_request.user_id);

    -- If the candidate has no sponsor yet, set the meet issuer as their profile sponsor
    if not exists (
      select 1 from public.profiles
      where id = v_caller_id and sponsor_id is not null
    ) then
      update public.profiles
      set sponsor_id = v_meet_request.user_id
      where id = v_caller_id;
    end if;

    -- Check if this endorsement meets the threshold
    perform public.check_endorsements(v_meet_request.group_id, v_caller_id);

    select name into v_group_name
    from public.groups where id = v_meet_request.group_id;

    select (status = 'active') into v_admitted
    from public.members
    where group_id = v_meet_request.group_id and user_id = v_caller_id;

    return json_build_object(
      'contact_id', v_meet_request.user_id,
      'contact_name', coalesce(v_contact_name, 'Unknown'),
      'group_id', v_meet_request.group_id,
      'group_name', v_group_name,
      'admitted', coalesce(v_admitted, false)
    );
  end if;

  return json_build_object(
    'contact_id', v_meet_request.user_id,
    'contact_name', coalesce(v_contact_name, 'Unknown')
  );
end;
$$ language plpgsql security definer;


-- ============================================================
-- GET MEET BY TOKEN: public lookup so non-members see who wants
-- to connect (no auth required, like get_sponsorship_by_token)
-- ============================================================
create or replace function public.get_meet_by_token(p_token text)
returns json as $$
declare
  v_meet record;
  v_name text;
  v_profile_image_url text;
  v_phone text;
  v_email text;
  v_group_name text;
  v_result json;
begin
  select * into v_meet
  from public.meet_requests
  where token = p_token
    and expires_at > now();

  if not found then
    return json_build_object('error', 'Meet request not found or expired');
  end if;

  select display_name, profile_image_url, phone, email
    into v_name, v_profile_image_url, v_phone, v_email
  from public.profiles
  where id = v_meet.user_id;

  v_result := json_build_object(
    'user_name', coalesce(v_name, 'A Union member'),
    'profile_image_url', v_profile_image_url,
    'phone', case when v_meet.share_phone then v_phone else null end,
    'email', case when v_meet.share_email then v_email else null end
  );

  if v_meet.group_id is not null then
    select name into v_group_name
    from public.groups where id = v_meet.group_id;

    v_result := json_build_object(
      'user_name', coalesce(v_name, 'A Union member'),
      'profile_image_url', v_profile_image_url,
      'phone', case when v_meet.share_phone then v_phone else null end,
      'email', case when v_meet.share_email then v_email else null end,
      'group_name', v_group_name,
      'message', v_meet.message
    );
  end if;

  return v_result;
end;
$$ language plpgsql security definer;


-- ============================================================
-- PUSH SUBSCRIPTIONS (Web Push notifications)
-- ============================================================
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  keys_p256dh text not null,
  keys_auth text not null,
  created_at timestamptz default now(),
  unique(user_id, endpoint)
);

alter table public.push_subscriptions enable row level security;

create policy "Users can manage own push subscriptions"
  on public.push_subscriptions for all
  using (auth.uid() = user_id);

-- Add push_notifications preference to profiles (default true)
alter table public.profiles add column if not exists push_notifications boolean default true;


-- ============================================================
-- PUSH NOTIFICATION DISPATCH FUNCTION
-- Looks up push subscriptions for group members and calls the
-- Edge Function via pg_net to deliver Web Push messages.
-- ============================================================
create or replace function public.send_push_to_group(
  p_group_id uuid,
  p_actor_id uuid,
  p_title text,
  p_body text,
  p_url text default '/',
  p_include_actor boolean default false
)
returns void as $$
declare
  v_edge_fn_url text;
  v_anon_key text;
  v_subscriptions jsonb;
begin
  -- Collect push subscriptions for group members who have push enabled
  select jsonb_agg(jsonb_build_object(
    'endpoint', ps.endpoint,
    'keys', jsonb_build_object('p256dh', ps.keys_p256dh, 'auth', ps.keys_auth)
  ))
  into v_subscriptions
  from public.push_subscriptions ps
  join public.members m on m.user_id = ps.user_id
  join public.profiles p on p.id = ps.user_id
  where m.group_id = p_group_id
    and m.status = 'active'
    and (p_include_actor or ps.user_id <> p_actor_id)
    and (p.push_notifications is null or p.push_notifications = true);

  if v_subscriptions is null then
    return;
  end if;

  -- Read Edge Function URL and anon key from Vault
  select decrypted_secret into v_edge_fn_url
  from vault.decrypted_secrets where name = 'push_edge_fn_url' limit 1;

  select decrypted_secret into v_anon_key
  from vault.decrypted_secrets where name = 'supabase_anon_key' limit 1;

  if v_edge_fn_url is null or v_anon_key is null then
    raise warning 'send_push_to_group: push_edge_fn_url or supabase_anon_key not in vault — skipping push';
    return;
  end if;

  perform net.http_post(
    url     := v_edge_fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_anon_key,
      'Content-Type',  'application/json'
    ),
    body    := jsonb_build_object(
      'subscriptions', v_subscriptions,
      'title', p_title,
      'body', p_body,
      'url', p_url
    )
  );
end;
$$ language plpgsql security definer;


-- ============================================================
-- TRIGGERS: Auto-dispatch push on group_events and chat_messages
-- ============================================================

-- Push on any group_events insert (covers payments, joins, amendments, rate changes, etc.)
create or replace function public.trigger_push_on_group_event()
returns trigger as $$
declare
  v_group_name text;
begin
  select name into v_group_name from public.groups where id = NEW.group_id;
  perform public.send_push_to_group(
    NEW.group_id,
    NEW.actor_id,
    coalesce(v_group_name, 'Union'),
    NEW.summary,
    '/?group=' || NEW.group_id::text
  );
  return NEW;
end;
$$ language plpgsql security definer;

create trigger on_group_event_push
  after insert on public.group_events
  for each row execute function public.trigger_push_on_group_event();


-- Push on new chat messages (separate from group_events)
create or replace function public.trigger_push_on_chat_message()
returns trigger as $$
declare
  v_group_name text;
  v_sender_name text;
  v_preview text;
  v_body text;
begin
  select name into v_group_name from public.groups where id = NEW.group_id;
  select display_name into v_sender_name from public.profiles where id = NEW.user_id;
  if NEW.body like '📷image:%' then
    v_body := coalesce(v_sender_name, 'Someone') || ' sent a photo';
  elsif NEW.body like '📍location:%' then
    v_body := coalesce(v_sender_name, 'Someone') || ' shared a location';
  else
    v_preview := left(NEW.body, 80);
    if length(NEW.body) > 80 then v_preview := v_preview || '...'; end if;
    v_body := coalesce(v_sender_name, 'Someone') || ': ' || v_preview;
  end if;

  perform public.send_push_to_group(
    NEW.group_id,
    NEW.user_id,
    coalesce(v_group_name, 'Union') || ' Chat',
    v_body,
    '/?group=' || NEW.group_id::text || '&tab=chat'
  );
  return NEW;
end;
$$ language plpgsql security definer;

create trigger on_chat_message_push
  after insert on public.chat_messages
  for each row execute function public.trigger_push_on_chat_message();


-- ============================================================
-- CONTACT NOTIFICATIONS
-- In-app and push notifications sent between contacts when
-- a profile picture changes, display name changes, or a "met on" date is set/updated.
-- ============================================================

create table if not exists public.contact_notifications (
  id uuid primary key default gen_random_uuid(),
  to_user_id uuid not null references public.profiles(id) on delete cascade,
  from_user_id uuid not null references public.profiles(id) on delete cascade,
  notification_type text not null check (notification_type in ('profile_picture_updated', 'profile_updated', 'met_date_set', 'profile_picture_suggested', 'display_name_changed')),
  message text not null,
  data jsonb default null,
  created_at timestamptz default now()
);

alter table public.contact_notifications enable row level security;

create policy "Users can read own contact notifications"
  on public.contact_notifications for select
  using (auth.uid() = to_user_id);

create policy "Authenticated users can insert contact notifications"
  on public.contact_notifications for insert
  with check (auth.uid() = from_user_id);

-- Allow the SECURITY DEFINER notify functions to insert on behalf of a user
create policy "Service role can insert contact notifications"
  on public.contact_notifications for insert
  with check (true);


-- Helper: send a Web Push notification to a list of specific user IDs.
-- Similar to send_push_to_group but targets arbitrary users instead of group members.
create or replace function public.send_push_to_users(
  p_user_ids uuid[],
  p_actor_id uuid,
  p_title text,
  p_body text,
  p_url text default '/'
)
returns void as $$
declare
  v_edge_fn_url text;
  v_anon_key text;
  v_subscriptions jsonb;
begin
  select jsonb_agg(jsonb_build_object(
    'endpoint', ps.endpoint,
    'keys', jsonb_build_object('p256dh', ps.keys_p256dh, 'auth', ps.keys_auth)
  ))
  into v_subscriptions
  from public.push_subscriptions ps
  join public.profiles p on p.id = ps.user_id
  where ps.user_id = any(p_user_ids)
    and ps.user_id <> p_actor_id
    and (p.push_notifications is null or p.push_notifications = true);

  if v_subscriptions is null then
    return;
  end if;

  select decrypted_secret into v_edge_fn_url
  from vault.decrypted_secrets where name = 'push_edge_fn_url' limit 1;

  select decrypted_secret into v_anon_key
  from vault.decrypted_secrets where name = 'supabase_anon_key' limit 1;

  if v_edge_fn_url is null or v_anon_key is null then
    raise warning 'send_push_to_users: push_edge_fn_url or supabase_anon_key not in vault — skipping push';
    return;
  end if;

  perform net.http_post(
    url     := v_edge_fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_anon_key,
      'Content-Type',  'application/json'
    ),
    body    := jsonb_build_object(
      'subscriptions', v_subscriptions,
      'title', p_title,
      'body', p_body,
      'url', p_url
    )
  );
end;
$$ language plpgsql security definer;


-- Notify all contacts when a user updates their profile picture.
-- Inserts a contact_notification row for each contact (Realtime in-app toast)
-- and sends a Web Push to contacts who have push enabled.
create or replace function public.notify_contacts_of_profile_picture_change(
  p_actor_id uuid
)
returns void as $$
declare
  v_name text;
  v_contact_ids uuid[];
  v_msg text;
  v_cid uuid;
begin
  if auth.uid() is distinct from p_actor_id then
    raise exception 'Unauthorized';
  end if;

  select display_name into v_name from public.profiles where id = p_actor_id;
  v_msg := coalesce(v_name, 'Someone') || ' updated their profile picture';

  -- All users who have p_actor_id as a contact
  select array_agg(user_id) into v_contact_ids
  from public.contacts
  where contact_id = p_actor_id;

  if v_contact_ids is null or cardinality(v_contact_ids) = 0 then
    return;
  end if;

  -- Insert in-app notification rows
  foreach v_cid in array v_contact_ids loop
    insert into public.contact_notifications (to_user_id, from_user_id, notification_type, message)
    values (v_cid, p_actor_id, 'profile_picture_updated', v_msg);
  end loop;

  -- Send Web Push to subscribed contacts. The URL carries the actor's id so a
  -- tap on the OS notification deep-links straight to that contact's details
  -- screen (via handleNotificationNavigation).
  perform public.send_push_to_users(
    v_contact_ids, p_actor_id, 'Union', v_msg,
    '/?action=view_contact&contact=' || p_actor_id::text
  );
end;
$$ language plpgsql security definer;


-- Notify all contacts when a user updates profile fields (e.g. email / phone).
-- Inserts `profile_updated` rows for in-app Realtime toasts and sends push.
create or replace function public.notify_contacts_of_profile_update(
  p_actor_id uuid,
  p_message text
)
returns void as $$
declare
  v_contact_ids uuid[];
  v_cid uuid;
begin
  if auth.uid() is distinct from p_actor_id then
    raise exception 'Unauthorized';
  end if;

  if p_message is null or trim(p_message) = '' then
    raise exception 'Message is required';
  end if;

  select array_agg(user_id) into v_contact_ids
  from public.contacts
  where contact_id = p_actor_id;

  if v_contact_ids is null or cardinality(v_contact_ids) = 0 then
    return;
  end if;

  foreach v_cid in array v_contact_ids loop
    insert into public.contact_notifications (to_user_id, from_user_id, notification_type, message)
    values (v_cid, p_actor_id, 'profile_updated', p_message);
  end loop;

  perform public.send_push_to_users(
    v_contact_ids, p_actor_id, 'Union', p_message,
    '/?action=view_contact&contact=' || p_actor_id::text
  );
end;
$$ language plpgsql security definer;


-- Notify all contacts when the user changes their display name (push + in-app).
create or replace function public.notify_contacts_of_display_name_change(
  p_actor_id uuid,
  p_old_display_name text,
  p_new_display_name text
)
returns void as $$
declare
  v_old text;
  v_new text;
  v_msg text;
  v_contact_ids uuid[];
  v_cid uuid;
begin
  if auth.uid() is distinct from p_actor_id then
    raise exception 'Unauthorized';
  end if;

  v_old := coalesce(nullif(btrim(p_old_display_name), ''), 'Someone');
  v_new := coalesce(nullif(btrim(p_new_display_name), ''), 'Someone');

  if v_old = v_new then
    return;
  end if;

  v_msg := v_old || ' changed their name to ' || v_new;

  select array_agg(user_id) into v_contact_ids
  from public.contacts
  where contact_id = p_actor_id;

  if v_contact_ids is null or cardinality(v_contact_ids) = 0 then
    return;
  end if;

  foreach v_cid in array v_contact_ids loop
    insert into public.contact_notifications (to_user_id, from_user_id, notification_type, message, data)
    values (
      v_cid,
      p_actor_id,
      'display_name_changed',
      v_msg,
      jsonb_build_object('old_display_name', v_old, 'new_display_name', v_new)
    );
  end loop;

  perform public.send_push_to_users(
    v_contact_ids, p_actor_id, 'Union', v_msg,
    '/?action=view_contact&contact=' || p_actor_id::text
  );
end;
$$ language plpgsql security definer;


-- Set the "first met" date for a contact pair.
-- Writes BOTH sides of the pair in a single transaction so the caller and the
-- contact always see the same date. When p_met_date is non-null we also notify
-- the contact (in-app + Web Push); clearing the date silently syncs both sides
-- with no notification.
create or replace function public.set_first_met_date(
  p_contact_id uuid,
  p_met_date timestamptz
)
returns void as $$
declare
  v_caller_id uuid := auth.uid();
  v_name text;
  v_date_str text;
  v_msg text;
begin
  if v_caller_id is null then
    raise exception 'You must be logged in';
  end if;

  if p_contact_id is null then
    raise exception 'Contact is required';
  end if;

  -- Verify the caller actually has p_contact_id as a contact.
  if not exists (
    select 1 from public.contacts
    where user_id = v_caller_id and contact_id = p_contact_id
  ) then
    raise exception 'Not a contact';
  end if;

  -- Update BOTH sides of the pair in one statement so the date is always
  -- identical between the caller and the contact.
  update public.contacts
  set first_met_at = p_met_date
  where (user_id = v_caller_id  and contact_id = p_contact_id)
     or (user_id = p_contact_id and contact_id = v_caller_id);

  -- Only notify the contact when a real date is set (skip on clearing).
  if p_met_date is null then
    return;
  end if;

  select display_name into v_name from public.profiles where id = v_caller_id;
  v_date_str := trim(to_char(p_met_date, 'Month DD, YYYY'));
  v_msg := coalesce(v_name, 'Someone') || ' says you met on ' || v_date_str;

  -- Insert in-app notification row (include date in data so the recipient's UI
  -- can update live without an extra fetch).
  insert into public.contact_notifications (to_user_id, from_user_id, notification_type, message, data)
  values (p_contact_id, v_caller_id, 'met_date_set', v_msg, jsonb_build_object('met_date', p_met_date));

  -- Send Web Push.
  perform public.send_push_to_users(ARRAY[p_contact_id], v_caller_id, 'Union', v_msg);
end;
$$ language plpgsql security definer;


-- Backwards-compatible shim for any client that still calls the old name.
-- Delegates to set_first_met_date; ignores p_actor_id (auth.uid() is the
-- source of truth in the new function).
create or replace function public.notify_contact_of_met_date(
  p_actor_id uuid,
  p_contact_id uuid,
  p_met_date timestamptz
)
returns void as $$
begin
  if auth.uid() is distinct from p_actor_id then
    raise exception 'Unauthorized';
  end if;
  perform public.set_first_met_date(p_contact_id, p_met_date);
end;
$$ language plpgsql security definer;


-- One-time backfill: where one side of a contact pair has first_met_at set
-- but the other side does not, copy it across so both sides agree.
-- Pairs where both sides have differing non-null values are left alone (we
-- can't know which is correct); the next user-driven change will resync them.
update public.contacts dst
set first_met_at = src.first_met_at
from public.contacts src
where src.user_id = dst.contact_id
  and src.contact_id = dst.user_id
  and src.first_met_at is not null
  and dst.first_met_at is null;


-- Suggest a new profile picture for a contact.
-- Inserts a contact_notification with the suggested image URL and sends Web Push.
create or replace function public.suggest_profile_picture(
  p_actor_id uuid,
  p_contact_id uuid,
  p_image_url text
)
returns void as $$
declare
  v_name text;
  v_msg text;
begin
  if auth.uid() is distinct from p_actor_id then
    raise exception 'Unauthorized';
  end if;

  if not exists (
    select 1 from public.contacts
    where user_id = p_actor_id and contact_id = p_contact_id
  ) then
    raise exception 'Not a contact';
  end if;

  select display_name into v_name from public.profiles where id = p_actor_id;
  v_msg := coalesce(v_name, 'Someone') || ' suggests this new profile picture';

  insert into public.contact_notifications (to_user_id, from_user_id, notification_type, message, data)
  values (p_contact_id, p_actor_id, 'profile_picture_suggested', v_msg,
          jsonb_build_object('image_url', p_image_url));

  perform public.send_push_to_users(ARRAY[p_contact_id], p_actor_id, 'Union', v_msg,
          '/?action=suggested_picture');
end;
$$ language plpgsql security definer;


-- Read the data column for a contact notification (bypasses PostgREST table cache).
create or replace function public.get_contact_notification_data(p_notification_id uuid)
returns jsonb as $$
  select data from public.contact_notifications
  where id = p_notification_id and to_user_id = auth.uid();
$$ language sql stable security definer;


-- ============================================================
-- STORAGE: Avatars bucket for public profile photos and contact selfies
-- ============================================================
-- Run in Supabase SQL Editor:
-- insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
--
-- create policy "Users can upload own media"
--   on storage.objects for insert
--   with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
--
-- create policy "Users can update own media"
--   on storage.objects for update
--   using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
--
-- create policy "Public avatars read"
--   on storage.objects for select
--   using (bucket_id = 'avatars');
