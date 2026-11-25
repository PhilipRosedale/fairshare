-- Offerings: things people lend, sell, do for someone, or gather around.
-- They show on the Map and in the Feed to the poster's contacts and fellow
-- group members.
--
-- Who sees an offering (can_see_offering):
--   it's yours, OR
--   it's shared with contacts and the poster has you as a contact, OR
--   it's shared with a group where you and the poster are both active members,
-- and in every case neither of you has blocked the other and it is still open
-- (not closed, not expired). You always see your own.
--
-- Writes go through save_offering() and close_offering(), which check group
-- membership and currency. Owners may delete their own rows directly.
-- Photos (up to six) live in the public avatars bucket at
-- <user_id>/offering_<id>_<ts>_<n>.jpg, like chat photos.
--
-- Apply: supabase db query --linked -f sql/offerings-schema.sql
-- (A database from before offerings could have several kinds needs
-- sql/offering-kinds-migration.sql first, and one from before they could
-- have several photos needs sql/offering-photos-migration.sql first.)

-- ----- tables -------------------------------------------------

create table if not exists public.offerings (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  kind           text not null check (kind in ('lend', 'sell', 'do', 'gather')),
  -- One or more kinds (Lend and Sell, say). kind is the first of them, which
  -- sets the color and icon.
  kinds          text[] not null check (cardinality(kinds) between 1 and 4
                   and kinds <@ array['lend', 'sell', 'do', 'gather']),
  description    text check (char_length(description) <= 1000),
  photo_url      text,                             -- the cover: photo_urls[1]
  photo_urls     text[] not null default '{}' check (cardinality(photo_urls) <= 6),
  lat            double precision not null check (lat between -90 and 90),
  lng            double precision not null check (lng between -180 and 180),
  exact          boolean not null default false,   -- false: point moved within ~200 m
  place_label    text check (char_length(place_label) <= 120),
  price          numeric check (price >= 0),       -- null = free
  price_group_id uuid references public.groups(id) on delete set null,  -- whose currency
  price_unit     text check (price_unit in ('each', 'hour', 'day')),
  to_contacts    boolean not null default true,
  starts_at      timestamptz,                      -- gatherings
  expires_at     timestamptz not null default now() + interval '14 days',
  closed_at      timestamptz,                      -- taken / done
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists offerings_user_idx    on public.offerings(user_id);
create index if not exists offerings_open_idx    on public.offerings(expires_at) where closed_at is null;
create index if not exists offerings_created_idx on public.offerings(created_at desc);

create table if not exists public.offering_groups (
  offering_id uuid not null references public.offerings(id) on delete cascade,
  group_id    uuid not null references public.groups(id) on delete cascade,
  primary key (offering_id, group_id)
);

create index if not exists offering_groups_group_idx on public.offering_groups(group_id);

alter table public.offerings enable row level security;
alter table public.offering_groups enable row level security;

-- ----- visibility ---------------------------------------------

create or replace function public.can_see_offering(p_offering_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.offerings o
    where o.id = p_offering_id
      and auth.uid() is not null
      and (
        o.user_id = auth.uid()
        or (
          o.closed_at is null
          and o.expires_at > now()
          and not exists (
            select 1 from public.blocked_users b
            where (b.blocker_id = auth.uid() and b.blocked_id = o.user_id)
               or (b.blocker_id = o.user_id and b.blocked_id = auth.uid())
          )
          and (
            (o.to_contacts and exists (
              select 1 from public.contacts c
              where c.user_id = o.user_id and c.contact_id = auth.uid()
            ))
            or exists (
              select 1
              from public.offering_groups og
              join public.members viewer on viewer.group_id = og.group_id
                and viewer.user_id = auth.uid() and viewer.status = 'active'
              join public.members poster on poster.group_id = og.group_id
                and poster.user_id = o.user_id and poster.status = 'active'
              where og.offering_id = o.id
            )
          )
        )
      )
  );
$$;

revoke all on function public.can_see_offering(uuid) from public;
grant execute on function public.can_see_offering(uuid) to authenticated;

drop policy if exists offerings_select_visible on public.offerings;
create policy offerings_select_visible on public.offerings
  for select to authenticated
  using (public.can_see_offering(id));

drop policy if exists offerings_delete_own on public.offerings;
create policy offerings_delete_own on public.offerings
  for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists offering_groups_select_visible on public.offering_groups;
create policy offering_groups_select_visible on public.offering_groups
  for select to authenticated
  using (public.can_see_offering(offering_id));

-- Inserts and updates only through the functions below.
revoke insert, update on public.offerings from authenticated;
revoke insert, update, delete on public.offering_groups from authenticated;

-- ----- writing ------------------------------------------------

-- Create (p_id not yet used) or edit (p_id is yours) an offering and its
-- groups in one step. The client picks the id so the photos can be uploaded
-- under it first. p_kinds is one or more kinds; p_kind alone is still
-- accepted from app builds that had one kind. Likewise p_photo_urls is the
-- photos in order (the first is the cover), and p_photo_url alone still
-- works: an edit from an older build that leaves the cover alone keeps the
-- other photos. Returns the offering id.
create or replace function public.save_offering(
  p_id             uuid,
  p_kind           text,
  p_description    text,
  p_photo_url      text,
  p_lat            double precision,
  p_lng            double precision,
  p_exact          boolean,
  p_place_label    text,
  p_price          numeric,
  p_price_group_id uuid,
  p_price_unit     text,
  p_to_contacts    boolean,
  p_group_ids      uuid[],
  p_starts_at      timestamptz,
  p_kinds          text[] default null,
  p_photo_urls     text[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id     uuid := auth.uid();
  v_owner       uuid;
  v_groups      uuid[];
  v_bad_group   uuid;
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_place       text := nullif(trim(coalesce(p_place_label, '')), '');
  v_expires     timestamptz;
  v_photos      text[];
  v_kinds       text[];
  v_kind        text;
  v_gather      boolean;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;
  if p_id is null then raise exception 'Missing offering id'; end if;

  -- Kinds: distinct and in a fixed order; the first is the main kind.
  if exists (
    select 1 from unnest(coalesce(p_kinds, array[p_kind])) as k
    where k is null or k not in ('lend', 'sell', 'do', 'gather')
  ) then
    raise exception 'Choose what kind of offering this is';
  end if;
  select array_agg(k order by array_position(array['lend', 'sell', 'do', 'gather'], k)) into v_kinds
  from (select distinct unnest(coalesce(p_kinds, array[p_kind])) as k) x;
  if v_kinds is null or cardinality(v_kinds) = 0 then
    raise exception 'Choose what kind of offering this is';
  end if;
  v_kind := v_kinds[1];
  v_gather := 'gather' = any(v_kinds);
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'The offering needs a location';
  end if;
  if v_description is not null and char_length(v_description) > 1000 then
    raise exception 'The description is too long (1,000 characters at most)';
  end if;
  if v_place is not null and char_length(v_place) > 120 then
    v_place := substring(v_place from 1 for 120);
  end if;

  -- Photos: in order, without repeats, at most six, and each one you
  -- uploaded to your own folder of the app's bucket.
  if p_photo_urls is not null then
    select coalesce(array_agg(u order by first_at), '{}') into v_photos
    from (
      select u, min(ord) as first_at
      from unnest(p_photo_urls) with ordinality as t(u, ord)
      where u is not null and trim(u) <> ''
      group by u
    ) x;
  else
    v_photos := case when nullif(trim(coalesce(p_photo_url, '')), '') is null then '{}'::text[] else array[p_photo_url] end;
  end if;
  if cardinality(v_photos) > 6 then
    raise exception 'Up to 6 photos';
  end if;
  if exists (
    select 1 from unnest(v_photos) as u
    where u not like '%/storage/v1/object/public/avatars/' || v_user_id::text || '/offering\_%' escape '\'
  ) then
    raise exception 'Invalid photo';
  end if;

  -- Groups: distinct, and you must be an active member of each.
  select coalesce(array_agg(distinct g), '{}') into v_groups
  from unnest(coalesce(p_group_ids, '{}'::uuid[])) as g
  where g is not null;

  select g into v_bad_group
  from unnest(v_groups) as g
  where not exists (
    select 1 from public.members m
    where m.group_id = g and m.user_id = v_user_id and m.status = 'active'
  )
  limit 1;
  if v_bad_group is not null then
    raise exception 'You can only share with groups you are an active member of';
  end if;

  if not coalesce(p_to_contacts, false) and cardinality(v_groups) = 0 then
    raise exception 'Choose who can see this offering';
  end if;

  -- Price: free (null) or an amount in one group's currency. With groups
  -- chosen, the currency must be one of theirs; contacts only, any of yours.
  if p_price is null then
    if p_price_group_id is not null then raise exception 'A free offering has no currency'; end if;
  else
    if p_price < 0 then raise exception 'The price cannot be negative'; end if;
    if p_price_group_id is null then raise exception 'Choose a currency for the price'; end if;
    if not exists (
      select 1 from public.members m
      join public.groups gr on gr.id = m.group_id
      where m.group_id = p_price_group_id and m.user_id = v_user_id and m.status = 'active'
        and coalesce(gr.currency_enabled, true)
    ) then
      raise exception 'That currency is not available';
    end if;
    if cardinality(v_groups) > 0 and not (p_price_group_id = any(v_groups)) then
      raise exception 'The currency must belong to a group you are sharing with';
    end if;
  end if;
  if p_price_unit is not null and p_price_unit not in ('each', 'hour', 'day') then
    raise exception 'Invalid price unit';
  end if;

  -- A gathering is shown until a few hours after it starts; anything else
  -- for two weeks from when it was first posted.
  if v_gather and p_starts_at is not null then
    v_expires := p_starts_at + interval '4 hours';
  end if;

  select user_id into v_owner from public.offerings where id = p_id for update;

  if v_owner is null then
    insert into public.offerings (
      id, user_id, kind, kinds, description, photo_url, photo_urls, lat, lng, exact, place_label,
      price, price_group_id, price_unit, to_contacts, starts_at, expires_at
    ) values (
      p_id, v_user_id, v_kind, v_kinds, v_description, v_photos[1], v_photos, p_lat, p_lng, coalesce(p_exact, false), v_place,
      p_price, case when p_price is null then null else p_price_group_id end,
      case when p_price is null then null else p_price_unit end,
      coalesce(p_to_contacts, false),
      case when v_gather then p_starts_at else null end,
      coalesce(v_expires, now() + interval '14 days')
    );
  elsif v_owner = v_user_id then
    update public.offerings set
      kind           = v_kind,
      kinds          = v_kinds,
      description    = v_description,
      -- An older build sends just the cover: if it's unchanged, so are the rest.
      photo_urls     = case when p_photo_urls is null and v_photos[1] is not distinct from photo_url
                            then photo_urls else v_photos end,
      photo_url      = v_photos[1],
      lat            = p_lat,
      lng            = p_lng,
      exact          = coalesce(p_exact, false),
      place_label    = v_place,
      price          = p_price,
      price_group_id = case when p_price is null then null else p_price_group_id end,
      price_unit     = case when p_price is null then null else p_price_unit end,
      to_contacts    = coalesce(p_to_contacts, false),
      starts_at      = case when v_gather then p_starts_at else null end,
      -- No longer a gathering with a time: two weeks from now.
      expires_at     = coalesce(v_expires, case when 'gather' = any(kinds) then now() + interval '14 days' else expires_at end),
      updated_at     = now()
    where id = p_id;
  else
    raise exception 'That offering is not yours';
  end if;

  delete from public.offering_groups where offering_id = p_id;
  insert into public.offering_groups (offering_id, group_id)
  select p_id, g from unnest(v_groups) as g;

  return p_id;
end;
$$;

revoke all on function public.save_offering(uuid, text, text, text, double precision, double precision, boolean, text, numeric, uuid, text, boolean, uuid[], timestamptz, text[], text[]) from public;
grant execute on function public.save_offering(uuid, text, text, text, double precision, double precision, boolean, text, numeric, uuid, text, boolean, uuid[], timestamptz, text[], text[]) to authenticated;

-- Mark your offering taken or done; it leaves everyone's Map and Feed.
create or replace function public.close_offering(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update public.offerings
     set closed_at = coalesce(closed_at, now()), updated_at = now()
   where id = p_id and user_id = auth.uid();
  if not found then raise exception 'That offering is not yours'; end if;
end;
$$;

revoke all on function public.close_offering(uuid) from public;
grant execute on function public.close_offering(uuid) to authenticated;

-- ----- reading ------------------------------------------------

-- Every open offering you can see (yours included), newest first, with what
-- the Map and Feed need: the poster's name and photo, how you know them
-- ('Contact' or a shared group's name; null for your own), the currency, and
-- the distance from p_lat/p_lng when given. p_km limits the distance and
-- p_kinds the kinds (an offering matches if it has any of them); null means
-- no limit.
create or replace function public.offerings_near(
  p_lat   double precision default null,
  p_lng   double precision default null,
  p_km    double precision default null,
  p_kinds text[] default null
)
returns table (
  id              uuid,
  user_id         uuid,
  kind            text,
  kinds           text[],
  description     text,
  photo_url       text,
  photo_urls      text[],
  lat             double precision,
  lng             double precision,
  exact           boolean,
  place_label     text,
  price           numeric,
  price_unit      text,
  price_group_id  uuid,
  currency_name   text,
  currency_symbol text,
  to_contacts     boolean,
  group_ids       uuid[],
  starts_at       timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz,
  is_mine         boolean,
  poster_name     text,
  poster_photo    text,
  known_as        text,
  distance_km     double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with visible as (
    select o.*,
      case when p_lat is null or p_lng is null then null
      else 6371.0 * 2 * asin(sqrt(
        power(sin(radians(o.lat - p_lat) / 2), 2)
        + cos(radians(p_lat)) * cos(radians(o.lat)) * power(sin(radians(o.lng - p_lng) / 2), 2)
      )) end as dist_km
    from public.offerings o
    where o.closed_at is null
      and o.expires_at > now()
      and (p_kinds is null or o.kinds && p_kinds)
      and public.can_see_offering(o.id)
  )
  select
    v.id, v.user_id, v.kind, v.kinds, v.description, v.photo_url, v.photo_urls, v.lat, v.lng, v.exact, v.place_label,
    v.price, v.price_unit, v.price_group_id, gr.currency_name, gr.currency_symbol,
    v.to_contacts,
    -- Only the groups you belong to, so a member never learns about others.
    coalesce((
      select array_agg(og.group_id)
      from public.offering_groups og
      join public.members m on m.group_id = og.group_id and m.user_id = auth.uid() and m.status = 'active'
      where og.offering_id = v.id
    ), '{}'),
    v.starts_at, v.expires_at, v.created_at,
    v.user_id = auth.uid(),
    p.display_name, p.profile_image_url,
    case
      when v.user_id = auth.uid() then null
      when exists (
        select 1 from public.contacts c
        where (c.user_id = auth.uid() and c.contact_id = v.user_id)
           or (c.user_id = v.user_id and c.contact_id = auth.uid())
      ) then 'Contact'
      else (
        select g2.name
        from public.offering_groups og
        join public.groups g2 on g2.id = og.group_id
        join public.members m on m.group_id = og.group_id and m.user_id = auth.uid() and m.status = 'active'
        where og.offering_id = v.id
        order by g2.name
        limit 1
      )
    end,
    v.dist_km
  from visible v
  join public.profiles p on p.id = v.user_id
  left join public.groups gr on gr.id = v.price_group_id
  where p_km is null or v.dist_km is null or v.dist_km <= p_km
  order by v.created_at desc
  limit 500;
$$;

revoke all on function public.offerings_near(double precision, double precision, double precision, text[]) from public;
grant execute on function public.offerings_near(double precision, double precision, double precision, text[]) to authenticated;

-- ----- photos -------------------------------------------------

-- Owners can remove their own offering photos when they delete an offering.
drop policy if exists "Users can delete own offering photos" on storage.objects;
create policy "Users can delete own offering photos" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
    and storage.filename(name) like 'offering\_%' escape '\'
  );

-- ----- reporting ----------------------------------------------

alter table public.reports drop constraint if exists reports_content_type_check;
alter table public.reports add constraint reports_content_type_check check (content_type in (
  'profile', 'profile_photo', 'chat_message', 'group_logo',
  'group_name', 'selfie', 'display_name', 'offering', 'other'
));

create or replace function public.report_content(p_reported_user_id uuid, p_content_type text, p_content_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_report_id uuid;
  v_clean_reason text;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;
  v_clean_reason := trim(coalesce(p_reason, ''));
  if length(v_clean_reason) = 0 then return jsonb_build_object('error', 'A reason is required'); end if;
  if length(v_clean_reason) > 2000 then v_clean_reason := substring(v_clean_reason from 1 for 2000); end if;
  if p_content_type is null or p_content_type not in (
    'profile', 'profile_photo', 'chat_message', 'group_logo',
    'group_name', 'selfie', 'display_name', 'offering', 'other'
  ) then return jsonb_build_object('error', 'Invalid content type'); end if;
  if p_reported_user_id is not null and p_reported_user_id = v_user_id then
    return jsonb_build_object('error', 'You cannot report yourself');
  end if;
  insert into public.reports (reporter_id, reported_user_id, content_type, content_id, reason)
       values (v_user_id, p_reported_user_id, p_content_type, p_content_id, v_clean_reason)
       returning id into v_report_id;
  return jsonb_build_object('success', true, 'report_id', v_report_id);
end; $$;
