-- Nearby notification schema for Union
-- Run this in Supabase SQL Editor.

-- 1. Add notify_nearby preference to contacts (per-contact opt-in)
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS notify_nearby boolean DEFAULT false;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS last_nearby_notified_at timestamptz;

-- 2. user_locations: latest GPS position for users who have opted into nearby notifications
CREATE TABLE IF NOT EXISTS public.user_locations (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  updated_at timestamptz DEFAULT now(),
  source_instance_id text,
  source_platform text,
  source_user_agent text
);

ALTER TABLE public.user_locations
  ADD COLUMN IF NOT EXISTS source_instance_id text,
  ADD COLUMN IF NOT EXISTS source_platform text,
  ADD COLUMN IF NOT EXISTS source_user_agent text;

ALTER TABLE public.user_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own location"
  ON public.user_locations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own location"
  ON public.user_locations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own location"
  ON public.user_locations FOR UPDATE
  USING (auth.uid() = user_id);

-- 3. Allow 'nearby_alert' as a contact notification type
ALTER TABLE public.contact_notifications
  DROP CONSTRAINT IF EXISTS contact_notifications_notification_type_check;

ALTER TABLE public.contact_notifications
  ADD CONSTRAINT contact_notifications_notification_type_check
  CHECK (notification_type IN (
    'profile_picture_updated',
    'profile_updated',
    'met_date_set',
    'profile_picture_suggested',
    'nearby_alert',
    'new_selfie'
  ));

-- Optional reverse-geocoded label (e.g. "San Francisco, California") attached
-- to the nearby_alert rows so the contact-history timeline can display
-- "Nearby together in <city>". Populated by the caller via the RPC below.
ALTER TABLE public.contact_notifications
  ADD COLUMN IF NOT EXISTS location_label text;

-- NOTE: superseded by sql/nearby-background.sql, which moves the nearby check
--    into a trigger on user_locations so background uploads fire it too.
-- 4. RPC: update caller's location and check for nearby mutual contacts.
--    If a mutual-notify contact is within 1 mile and hasn't been notified in the
--    last hour, sends an in-app notification + Web Push.
DROP FUNCTION IF EXISTS public.update_location_and_check_nearby(double precision, double precision);
DROP FUNCTION IF EXISTS public.update_location_and_check_nearby(double precision, double precision, text);
CREATE OR REPLACE FUNCTION public.update_location_and_check_nearby(
  p_lat double precision,
  p_lng double precision,
  p_location_label text DEFAULT NULL,
  p_source_instance_id text DEFAULT NULL,
  p_source_platform text DEFAULT NULL,
  p_source_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_nearby record;
  v_distance double precision;
  v_my_name text;
  v_contact_name text;
  v_notified_ids uuid[] := '{}';
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.location_shares ls
    WHERE ls.from_user_id = v_user_id
      AND (ls.expires_at IS NULL OR ls.expires_at > now())
      AND ls.source_instance_id IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM public.location_shares ls
    WHERE ls.from_user_id = v_user_id
      AND (ls.expires_at IS NULL OR ls.expires_at > now())
      AND ls.source_instance_id = p_source_instance_id
  ) THEN
    RAISE EXCEPTION 'Location updates for active sharing must come from the sharing device';
  END IF;

  -- Upsert our location
  INSERT INTO public.user_locations (
    user_id, lat, lng, updated_at,
    source_instance_id, source_platform, source_user_agent
  )
  VALUES (
    v_user_id, p_lat, p_lng, now(),
    p_source_instance_id, p_source_platform, p_source_user_agent
  )
  ON CONFLICT (user_id)
  DO UPDATE SET
    lat = p_lat,
    lng = p_lng,
    updated_at = now(),
    source_instance_id = p_source_instance_id,
    source_platform = p_source_platform,
    source_user_agent = p_source_user_agent;

  -- Look up our display name once
  SELECT display_name INTO v_my_name
  FROM public.profiles WHERE id = v_user_id;

  -- Find mutual notify_nearby contacts with a recent location (last 10 minutes)
  FOR v_nearby IN
    SELECT
      c1.contact_id,
      c1.last_nearby_notified_at,
      ul.lat AS contact_lat,
      ul.lng AS contact_lng
    FROM public.contacts c1
    JOIN public.contacts c2
      ON c2.user_id = c1.contact_id AND c2.contact_id = c1.user_id
    JOIN public.user_locations ul
      ON ul.user_id = c1.contact_id
    WHERE c1.user_id = v_user_id
      AND c1.notify_nearby = true
      AND c2.notify_nearby = true
      AND ul.updated_at > now() - interval '10 minutes'
  LOOP
    -- Haversine distance in miles (Earth radius ~3959 mi)
    v_distance := 3959.0 * acos(
      LEAST(1.0, GREATEST(-1.0,
        cos(radians(p_lat)) * cos(radians(v_nearby.contact_lat)) *
        cos(radians(v_nearby.contact_lng) - radians(p_lng)) +
        sin(radians(p_lat)) * sin(radians(v_nearby.contact_lat))
      ))
    );

    IF v_distance <= 1.0 THEN
      -- Only notify if we haven't notified in the last hour
      IF v_nearby.last_nearby_notified_at IS NULL
         OR v_nearby.last_nearby_notified_at < now() - interval '1 hour' THEN

        -- Look up contact's display name for the reciprocal notification
        SELECT display_name INTO v_contact_name
        FROM public.profiles WHERE id = v_nearby.contact_id;

        -- In-app notification for the contact
        INSERT INTO public.contact_notifications
          (to_user_id, from_user_id, notification_type, message, location_label)
        VALUES
          (v_nearby.contact_id, v_user_id, 'nearby_alert',
           coalesce(v_my_name, 'Someone') || ' is nearby!',
           p_location_label);

        -- In-app notification for the caller
        INSERT INTO public.contact_notifications
          (to_user_id, from_user_id, notification_type, message, location_label)
        VALUES
          (v_user_id, v_nearby.contact_id, 'nearby_alert',
           coalesce(v_contact_name, 'Someone') || ' is nearby!',
           p_location_label);

        -- Web Push to both parties
        PERFORM public.send_push_to_users(
          ARRAY[v_nearby.contact_id], v_user_id, 'Union',
          coalesce(v_my_name, 'Someone') || ' is nearby!'
        );
        PERFORM public.send_push_to_users(
          ARRAY[v_user_id], v_nearby.contact_id, 'Union',
          coalesce(v_contact_name, 'Someone') || ' is nearby!'
        );

        -- Update last-notified timestamps on both sides to avoid duplicates
        UPDATE public.contacts
        SET last_nearby_notified_at = now()
        WHERE user_id = v_user_id AND contact_id = v_nearby.contact_id;

        UPDATE public.contacts
        SET last_nearby_notified_at = now()
        WHERE user_id = v_nearby.contact_id AND contact_id = v_user_id;

        v_notified_ids := v_notified_ids || v_nearby.contact_id;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('notified', v_notified_ids);
END;
$$;
