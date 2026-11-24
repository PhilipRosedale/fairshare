-- Nearby alerts from background location
-- Run this in Supabase SQL Editor after nearby-schema.sql and
-- location-sharing-schema.sql. Safe to run more than once.
--
-- Before this, the "is nearby" check lived only inside the RPC
-- update_location_and_check_nearby, which the app calls from a foreground
-- timer. Background uploads from the iOS/Android BackgroundLocation plugin go
-- through the location-upload Edge Function, which writes user_locations
-- directly, so nothing checked for nearby contacts until someone opened the
-- app. Now the check runs in a trigger on user_locations, so every writer
-- (foreground RPC, web sharing poller, native background uploads) fires it.

-- Optional reverse-geocoded label for the latest fix ("San Francisco,
-- California"). The foreground RPC fills it; background uploads clear it.
ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS location_label text;

-- ---------- 1. The check itself ----------
-- Internal: called only by the trigger below. Notifies both sides when a
-- mutual notify_nearby contact is within 1 mile and neither has been told in
-- the last hour.
--
-- How fresh the other person's position must be depends on where it came
-- from. The phone apps keep a 150 m exit geofence armed and upload whenever
-- they leave it, so an older native position still means "they are here".
-- Web clients only upload while the page is open, so their positions go
-- stale quickly.
CREATE OR REPLACE FUNCTION public._check_nearby_for_user(
  p_user_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_location_label text
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nearby record;
  v_distance double precision;
  v_my_name text;
  v_contact_name text;
  v_notified_ids uuid[] := '{}';
BEGIN
  SELECT display_name INTO v_my_name
  FROM public.profiles WHERE id = p_user_id;

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
    WHERE c1.user_id = p_user_id
      AND c1.notify_nearby = true
      AND c2.notify_nearby = true
      AND ul.updated_at > now() - CASE
            WHEN ul.source_platform IN ('ios', 'android') THEN interval '2 hours'
            ELSE interval '10 minutes'
          END
  LOOP
    -- Haversine distance in miles (Earth radius ~3959 mi)
    v_distance := 3959.0 * acos(
      LEAST(1.0, GREATEST(-1.0,
        cos(radians(p_lat)) * cos(radians(v_nearby.contact_lat)) *
        cos(radians(v_nearby.contact_lng) - radians(p_lng)) +
        sin(radians(p_lat)) * sin(radians(v_nearby.contact_lat))
      ))
    );

    IF v_distance <= 1.0 AND (
         v_nearby.last_nearby_notified_at IS NULL
         OR v_nearby.last_nearby_notified_at < now() - interval '1 hour'
       ) THEN

      SELECT display_name INTO v_contact_name
      FROM public.profiles WHERE id = v_nearby.contact_id;

      INSERT INTO public.contact_notifications
        (to_user_id, from_user_id, notification_type, message, location_label)
      VALUES
        (v_nearby.contact_id, p_user_id, 'nearby_alert',
         coalesce(v_my_name, 'Someone') || ' is nearby!',
         p_location_label);

      INSERT INTO public.contact_notifications
        (to_user_id, from_user_id, notification_type, message, location_label)
      VALUES
        (p_user_id, v_nearby.contact_id, 'nearby_alert',
         coalesce(v_contact_name, 'Someone') || ' is nearby!',
         p_location_label);

      PERFORM public.send_push_to_users(
        ARRAY[v_nearby.contact_id], p_user_id, 'Union',
        coalesce(v_my_name, 'Someone') || ' is nearby!'
      );
      PERFORM public.send_push_to_users(
        ARRAY[p_user_id], v_nearby.contact_id, 'Union',
        coalesce(v_contact_name, 'Someone') || ' is nearby!'
      );

      UPDATE public.contacts
      SET last_nearby_notified_at = now()
      WHERE user_id = p_user_id AND contact_id = v_nearby.contact_id;

      UPDATE public.contacts
      SET last_nearby_notified_at = now()
      WHERE user_id = v_nearby.contact_id AND contact_id = p_user_id;

      v_notified_ids := v_notified_ids || v_nearby.contact_id;
    END IF;
  END LOOP;

  RETURN v_notified_ids;
END;
$$;

REVOKE ALL ON FUNCTION public._check_nearby_for_user(uuid, double precision, double precision, text)
  FROM PUBLIC, anon, authenticated;

-- ---------- 2. Trigger on user_locations ----------
CREATE OR REPLACE FUNCTION public.trigger_check_nearby_on_location()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only a fresh fix counts; a delayed retry of an old fix should not alert.
  IF NEW.updated_at IS NULL OR NEW.updated_at < now() - interval '10 minutes' THEN
    RETURN NEW;
  END IF;
  -- Never let a nearby-check problem fail the location write itself.
  BEGIN
    PERFORM public._check_nearby_for_user(NEW.user_id, NEW.lat, NEW.lng, NEW.location_label);
  EXCEPTION WHEN others THEN
    RAISE WARNING 'nearby check failed for %: %', NEW.user_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_check_nearby_on_location() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS user_locations_check_nearby ON public.user_locations;
CREATE TRIGGER user_locations_check_nearby
  AFTER INSERT OR UPDATE OF lat, lng, updated_at ON public.user_locations
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_check_nearby_on_location();

-- ---------- 3. Foreground RPC now only writes the location ----------
-- Same signature and checks as before; the trigger does the nearby work.
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
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
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

  INSERT INTO public.user_locations (
    user_id, lat, lng, updated_at, location_label,
    source_instance_id, source_platform, source_user_agent
  )
  VALUES (
    v_user_id, p_lat, p_lng, now(), p_location_label,
    p_source_instance_id, p_source_platform, p_source_user_agent
  )
  ON CONFLICT (user_id)
  DO UPDATE SET
    lat = p_lat,
    lng = p_lng,
    updated_at = now(),
    location_label = p_location_label,
    source_instance_id = p_source_instance_id,
    source_platform = p_source_platform,
    source_user_agent = p_source_user_agent;

  RETURN jsonb_build_object('ok', true);
END;
$$;
