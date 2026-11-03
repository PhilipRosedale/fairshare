-- Payment codes: one-shot QR codes for in-person Pay and Request.
--
-- Model (see docs/payment-codes.md):
--   Whoever knows the amount types it and makes a code. The other person scans it.
--   A 'request' code means the scanner pays the creator (a bill, held up by the bartender).
--   A 'pay' code means the creator pays the scanner (the customer typed 20 and holds it up).
--   The payer is always the one whose balance is checked at the moment of redemption,
--   and money moves through the same rules as send_currency (fee applied, both active members).
--
-- Apply with:  supabase db query --linked -f sql/payment-codes-schema.sql
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table if not exists public.payment_requests (
  id             uuid primary key default gen_random_uuid(),
  token          text unique not null default encode(gen_random_bytes(16), 'hex'),
  group_id       uuid not null references public.groups(id) on delete cascade,
  creator_id     uuid not null references public.profiles(id) on delete cascade,
  direction      text not null check (direction in ('pay', 'request')),
  amount         numeric not null check (amount > 0),
  memo           text,
  status         text not null default 'open' check (status in ('open', 'settled', 'cancelled', 'expired')),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '15 minutes'),
  settled_at     timestamptz,
  settled_by     uuid references public.profiles(id) on delete set null,
  transaction_id uuid references public.transactions(id) on delete set null
);

create index if not exists payment_requests_creator_status_idx on public.payment_requests (creator_id, status);
create index if not exists payment_requests_token_idx on public.payment_requests (token);

-- Realtime UPDATE events need the full row so the creator's filter on their own id matches.
alter table public.payment_requests replica identity full;

alter table public.payment_requests enable row level security;

-- The creator can watch their own code (this is what makes the "they scanned it" moment live),
-- and the person who settled it can read it back as a receipt. Nobody writes directly:
-- every change goes through the SECURITY DEFINER functions below.
drop policy if exists "Creator or settler can view payment request" on public.payment_requests;
create policy "Creator or settler can view payment request"
  on public.payment_requests for select
  using (auth.uid() = creator_id or auth.uid() = settled_by);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'payment_requests'
  ) then
    alter publication supabase_realtime add table public.payment_requests;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Internal transfer (not callable by clients)
--    Same rules as send_currency, but the payer is a parameter rather than auth.uid(),
--    because a 'pay' code is redeemed by the receiver yet the creator is the one paying.
-- ---------------------------------------------------------------------------
create or replace function public._transfer_currency(
  p_group_id uuid,
  p_from uuid,
  p_to uuid,
  p_amount numeric,
  p_memo text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee_rate numeric;
  v_fee numeric;
  v_net numeric;
  v_from_balance numeric;
  v_tx_id uuid;
  v_symbol text;
begin
  if p_from = p_to then
    raise exception 'Cannot pay yourself';
  end if;

  select fee_rate, currency_symbol into v_fee_rate, v_symbol
  from public.groups where id = p_group_id;
  if not found then
    raise exception 'Group not found';
  end if;

  v_fee := round(p_amount * v_fee_rate, 2);
  v_net := p_amount - v_fee;

  select balance into v_from_balance
  from public.members
  where group_id = p_group_id and user_id = p_from and status = 'active'
  for update;
  if not found then
    raise exception 'The payer is not an active member of this group';
  end if;
  if v_from_balance < p_amount then
    raise exception 'Insufficient balance';
  end if;

  if not exists (
    select 1 from public.members
    where group_id = p_group_id and user_id = p_to and status = 'active'
  ) then
    raise exception 'The recipient is not an active member of this group';
  end if;

  update public.members set balance = balance - p_amount
  where group_id = p_group_id and user_id = p_from;

  update public.members set balance = balance + v_net
  where group_id = p_group_id and user_id = p_to;

  -- The fee leaves circulation, exactly as in send_currency.

  insert into public.transactions (group_id, from_user, to_user, amount, fee, memo)
  values (p_group_id, p_from, p_to, p_amount, v_fee, p_memo)
  returning id into v_tx_id;

  insert into public.group_events (group_id, event_type, summary, actor_id, metadata)
  values (
    p_group_id,
    'payment_received',
    (select display_name from public.profiles where id = p_from)
      || ' sent ' || v_symbol || ' ' || round(v_net, 2) || ' to '
      || (select display_name from public.profiles where id = p_to),
    p_from,
    json_build_object('from_user', p_from, 'to_user', p_to,
      'amount', p_amount, 'fee', v_fee, 'net', v_net, 'via', 'payment_code')::jsonb
  );

  return json_build_object('transaction_id', v_tx_id, 'amount', p_amount, 'fee', v_fee, 'net', v_net);
end;
$$;

revoke all on function public._transfer_currency(uuid, uuid, uuid, numeric, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Create a code
-- ---------------------------------------------------------------------------
create or replace function public.create_payment_code(
  p_group_id uuid,
  p_direction text,
  p_amount numeric,
  p_memo text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_group record;
  v_amount numeric := round(p_amount, 2);
  v_balance numeric;
  v_row public.payment_requests;
begin
  if v_user is null then
    raise exception 'Not signed in';
  end if;
  if p_direction not in ('pay', 'request') then
    raise exception 'Direction must be pay or request';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception 'Amount must be more than zero';
  end if;

  select id, name, currency_name, currency_symbol, currency_enabled
  into v_group from public.groups where id = p_group_id;
  if not found then
    raise exception 'Group not found';
  end if;
  if not v_group.currency_enabled then
    raise exception 'This group does not use currency';
  end if;

  select balance into v_balance
  from public.members
  where group_id = p_group_id and user_id = v_user and status = 'active';
  if not found then
    raise exception 'You are not an active member of %', v_group.name;
  end if;

  -- A 'pay' code is a promise to pay; refuse to make one you could not honour right now.
  -- (The balance is checked again when it is redeemed.)
  if p_direction = 'pay' and v_balance < v_amount then
    raise exception 'Insufficient balance';
  end if;

  -- One live code per person. Anything older still open is cancelled so a stale
  -- screenshot or a forgotten screen cannot be scanned later.
  update public.payment_requests
  set status = 'cancelled'
  where creator_id = v_user and status = 'open';

  insert into public.payment_requests (group_id, creator_id, direction, amount, memo)
  values (p_group_id, v_user, p_direction, v_amount, nullif(trim(p_memo), ''))
  returning * into v_row;

  return json_build_object(
    'id', v_row.id,
    'token', v_row.token,
    'direction', v_row.direction,
    'amount', v_row.amount,
    'memo', v_row.memo,
    'expires_at', v_row.expires_at,
    'group', json_build_object(
      'id', v_group.id, 'name', v_group.name,
      'currency_name', v_group.currency_name, 'currency_symbol', v_group.currency_symbol
    ),
    'creator', json_build_object(
      'id', v_user,
      'display_name', (select display_name from public.profiles where id = v_user)
    )
  );
end;
$$;

grant execute on function public.create_payment_code(uuid, text, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Read a code (the scanner's preview, before anything moves)
-- ---------------------------------------------------------------------------
create or replace function public.get_payment_code(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row public.payment_requests;
  v_group record;
  v_member boolean;
  v_my_balance numeric;
begin
  if v_user is null then
    raise exception 'Not signed in';
  end if;

  select * into v_row from public.payment_requests where token = p_token;
  if not found then
    raise exception 'That code is not a Union payment code';
  end if;

  if v_row.status = 'open' and v_row.expires_at < now() then
    update public.payment_requests set status = 'expired' where id = v_row.id;
    v_row.status := 'expired';
  end if;

  select id, name, currency_name, currency_symbol into v_group
  from public.groups where id = v_row.group_id;

  select (count(*) > 0), max(balance) into v_member, v_my_balance
  from public.members
  where group_id = v_row.group_id and user_id = v_user and status = 'active';

  return json_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'direction', v_row.direction,
    'amount', v_row.amount,
    'memo', v_row.memo,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at,
    'is_yours', (v_row.creator_id = v_user),
    'you_are_member', coalesce(v_member, false),
    'your_balance', v_my_balance,
    'group', json_build_object(
      'id', v_group.id, 'name', v_group.name,
      'currency_name', v_group.currency_name, 'currency_symbol', v_group.currency_symbol
    ),
    'creator', json_build_object(
      'id', v_row.creator_id,
      'display_name', (select display_name from public.profiles where id = v_row.creator_id)
    )
  );
end;
$$;

grant execute on function public.get_payment_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Redeem a code (this is the moment money moves)
-- ---------------------------------------------------------------------------
create or replace function public.redeem_payment_code(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row public.payment_requests;
  v_group record;
  v_from uuid;
  v_to uuid;
  v_tx json;
  v_my_balance numeric;
  v_creator_name text;
  v_scanner_name text;
  v_push_body text;
begin
  if v_user is null then
    raise exception 'Not signed in';
  end if;

  -- Lock the code so two scans cannot both succeed.
  select * into v_row from public.payment_requests where token = p_token for update;
  if not found then
    raise exception 'That code is not a Union payment code';
  end if;
  if v_row.creator_id = v_user then
    raise exception 'That is your own code';
  end if;
  if v_row.status = 'open' and v_row.expires_at < now() then
    update public.payment_requests set status = 'expired' where id = v_row.id;
    raise exception 'This code has expired. Ask them to make a new one';
  end if;
  if v_row.status <> 'open' then
    raise exception 'This code has already been used';
  end if;

  select id, name, currency_name, currency_symbol into v_group
  from public.groups where id = v_row.group_id;

  if not exists (
    select 1 from public.members
    where group_id = v_row.group_id and user_id = v_user and status = 'active'
  ) then
    raise exception 'This is a % code and you are not a member of that group', v_group.name;
  end if;

  -- The code decides the direction. The scanner never chooses.
  if v_row.direction = 'request' then
    v_from := v_user;          -- scanner pays the bill
    v_to   := v_row.creator_id;
  else
    v_from := v_row.creator_id; -- creator promised to pay; scanner collects
    v_to   := v_user;
  end if;

  v_tx := public._transfer_currency(v_row.group_id, v_from, v_to, v_row.amount, v_row.memo);

  update public.payment_requests
  set status = 'settled',
      settled_at = now(),
      settled_by = v_user,
      transaction_id = (v_tx->>'transaction_id')::uuid
  where id = v_row.id;

  select balance into v_my_balance
  from public.members where group_id = v_row.group_id and user_id = v_user;

  select display_name into v_creator_name from public.profiles where id = v_row.creator_id;
  select display_name into v_scanner_name from public.profiles where id = v_user;

  -- Tell the phone that was holding the code up, in case the app is in the background.
  -- Realtime on payment_requests covers the foreground case.
  if v_row.direction = 'request' then
    v_push_body := coalesce(v_scanner_name, 'Someone') || ' paid you '
      || v_group.currency_symbol || round((v_tx->>'net')::numeric, 2)
      || coalesce(' for ' || v_row.memo, '');
  else
    v_push_body := coalesce(v_scanner_name, 'Someone') || ' collected your '
      || v_group.currency_symbol || round(v_row.amount, 2)
      || coalesce(' for ' || v_row.memo, '');
  end if;
  begin
    perform public.send_push_to_users(
      array[v_row.creator_id], v_user, 'Union', v_push_body,
      '/?action=view_group&group=' || v_row.group_id::text
    );
  exception when others then
    -- A push failure must never undo a payment.
    null;
  end;

  return json_build_object(
    'id', v_row.id,
    'direction', v_row.direction,
    'you_paid', (v_from = v_user),
    'amount', (v_tx->>'amount')::numeric,
    'fee', (v_tx->>'fee')::numeric,
    'net', (v_tx->>'net')::numeric,
    'memo', v_row.memo,
    'settled_at', now(),
    'transaction_id', v_tx->>'transaction_id',
    'your_balance', v_my_balance,
    'other', json_build_object('id', v_row.creator_id, 'display_name', v_creator_name),
    'group', json_build_object(
      'id', v_group.id, 'name', v_group.name,
      'currency_name', v_group.currency_name, 'currency_symbol', v_group.currency_symbol
    )
  );
end;
$$;

grant execute on function public.redeem_payment_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Cancel a code (Cancel on the code screen)
-- ---------------------------------------------------------------------------
create or replace function public.cancel_payment_code(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_n int;
begin
  if v_user is null then
    raise exception 'Not signed in';
  end if;
  update public.payment_requests
  set status = 'cancelled'
  where token = p_token and creator_id = v_user and status = 'open';
  get diagnostics v_n = row_count;
  return json_build_object('cancelled', v_n > 0);
end;
$$;

grant execute on function public.cancel_payment_code(text) to authenticated;
