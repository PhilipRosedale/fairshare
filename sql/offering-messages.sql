-- Messages about offerings: you can message someone whose open offering you
-- can see, even if you aren't contacts, and they can write back.
--
-- Who you can message (can_direct_message):
--   a contact (as before), OR
--   someone with an open offering you can see (see can_see_offering in
--   sql/offerings-schema.sql), OR
--   someone who has already messaged you, so a conversation can go both ways,
-- and never across a block in either direction.
--
-- A message about an offering starts with "🏷offering:<id>" on its own line,
-- then the text. The app shows the offering as a card above the text.
--
-- Apply: supabase db query --linked -f sql/offering-messages.sql

create or replace function public.can_direct_message(p_to uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and p_to is not null
    and p_to <> auth.uid()
    and not exists (
      select 1 from public.blocked_users b
      where (b.blocker_id = auth.uid() and b.blocked_id = p_to)
         or (b.blocker_id = p_to and b.blocked_id = auth.uid())
    )
    and (
      exists (select 1 from public.contacts c where c.user_id = auth.uid() and c.contact_id = p_to)
      or exists (
        select 1 from public.offerings o
        where o.user_id = p_to and o.closed_at is null and o.expires_at > now()
          and public.can_see_offering(o.id)
      )
      or exists (
        select 1 from public.direct_messages dm
        where dm.from_user_id = p_to and dm.to_user_id = auth.uid()
      )
    );
$$;

revoke all on function public.can_direct_message(uuid) from public;
grant execute on function public.can_direct_message(uuid) to authenticated;

-- ----- sending ------------------------------------------------

drop policy if exists "Users can send direct messages to contacts" on public.direct_messages;
drop policy if exists "Users can send direct messages" on public.direct_messages;
create policy "Users can send direct messages"
  on public.direct_messages for insert
  with check (auth.uid() = from_user_id and public.can_direct_message(to_user_id));

-- The typing indicator follows the same rule as sending.
drop policy if exists "Users can upsert own typing rows" on public.direct_message_typing;
create policy "Users can upsert own typing rows"
  on public.direct_message_typing for insert
  with check (auth.uid() = user_id and public.can_direct_message(peer_user_id));

drop policy if exists "Users can update own typing rows" on public.direct_message_typing;
create policy "Users can update own typing rows"
  on public.direct_message_typing for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and public.can_direct_message(peer_user_id));

-- ----- push ---------------------------------------------------

create or replace function public.trigger_push_on_direct_message()
returns trigger as $$
declare
  v_sender_name text;
  v_preview text;
  v_body text;
  v_text text;
begin
  select display_name into v_sender_name
  from public.profiles
  where id = NEW.from_user_id;

  if NEW.body like '📷image:%' then
    v_body := coalesce(v_sender_name, 'Someone') || ' sent a photo';
  elsif NEW.body like '📍location:%' then
    v_body := coalesce(v_sender_name, 'Someone') || ' shared a location';
  elsif NEW.body like '🏷offering:%' then
    -- "🏷offering:<id>" line, then what they wrote.
    v_text := trim(substring(NEW.body from position(chr(10) in NEW.body) + 1));
    if position(chr(10) in NEW.body) = 0 then v_text := ''; end if;
    v_preview := left(v_text, 80);
    if length(v_text) > 80 then v_preview := v_preview || '...'; end if;
    v_body := coalesce(v_sender_name, 'Someone') || ' asked about your offering'
      || case when v_preview <> '' then ': ' || v_preview else '' end;
  else
    v_preview := left(NEW.body, 80);
    if length(NEW.body) > 80 then
      v_preview := v_preview || '...';
    end if;
    v_body := coalesce(v_sender_name, 'Someone') || ': ' || v_preview;
  end if;

  perform public.send_push_to_users(
    array[NEW.to_user_id],
    NEW.from_user_id,
    'Union',
    v_body,
    '/?action=view_dm&contact=' || NEW.from_user_id::text
  );
  return NEW;
end;
$$ language plpgsql security definer;

-- ----- finding conversations ----------------------------------

-- Conversations with people who aren't your contacts (they can only come
-- from offerings), newest first: who, their last message, and the latest
-- offering the conversation is about. The Contacts screen lists these.
create or replace function public.dm_other_threads()
returns table (
  peer_id       uuid,
  display_name  text,
  profile_image_url text,
  last_body     text,
  last_from_me  boolean,
  last_at       timestamptz,
  offering_id   uuid
)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select dm.*,
      case when dm.from_user_id = auth.uid() then dm.to_user_id else dm.from_user_id end as peer
    from public.direct_messages dm
    where auth.uid() is not null
      and (dm.from_user_id = auth.uid() or dm.to_user_id = auth.uid())
  ),
  peers as (
    select distinct on (m.peer) m.peer, m.body, m.from_user_id = auth.uid() as from_me, m.created_at
    from mine m
    where not exists (select 1 from public.contacts c where c.user_id = auth.uid() and c.contact_id = m.peer)
      and not exists (
        select 1 from public.blocked_users b
        where (b.blocker_id = auth.uid() and b.blocked_id = m.peer)
           or (b.blocker_id = m.peer and b.blocked_id = auth.uid())
      )
    order by m.peer, m.created_at desc
  )
  select
    p.peer, pr.display_name, pr.profile_image_url, p.body, p.from_me, p.created_at,
    (
      select (substring(m2.body from '^🏷offering:([0-9a-f-]{36})'))::uuid
      from mine m2
      where m2.peer = p.peer and m2.body like '🏷offering:%'
      order by m2.created_at desc
      limit 1
    )
  from peers p
  join public.profiles pr on pr.id = p.peer
  order by p.created_at desc
  limit 50;
$$;

revoke all on function public.dm_other_threads() from public;
grant execute on function public.dm_other_threads() to authenticated;
