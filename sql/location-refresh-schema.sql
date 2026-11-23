-- On-demand location refresh (Find My style)
-- Run this in Supabase SQL Editor after location-sharing-schema.sql and
-- apns-push-schema.sql.
--
-- When someone opens the details of a contact who shares location with them
-- and the position is stale, the app calls request_location_refresh. This
-- sends a silent push to the sharer's phones; the phone takes one fix and
-- uploads it through the location-upload Edge Function, and the viewer sees
-- it arrive over Realtime ("Updated Just now").

-- One row per sharer: when their phone was last asked for a fresh fix. Kept
-- out of location_shares on purpose, because every change there fans out to
-- both clients over Realtime and reloads their contact lists.
CREATE TABLE IF NOT EXISTS public.location_refresh_requests (
  sharer_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now()
);

-- No policies: only request_location_refresh (security definer) touches it.
ALTER TABLE public.location_refresh_requests ENABLE ROW LEVEL SECURITY;

-- Returns one of:
--   'sent'       silent push sent to the sharer's devices
--   'throttled'  another request went out in the last minute; its fix is on the way
--   'fresh'      the location is already under a minute old
--   'no_device'  the sharer has no app install that can receive the push
--   'not_shared' the sharer is not sharing location with the caller
CREATE OR REPLACE FUNCTION public.request_location_refresh(p_sharer_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_viewer uuid := auth.uid();
  v_updated_at timestamptz;
  v_device_tokens jsonb;
  v_apns_edge_fn_url text;
  v_anon_key text;
BEGIN
  IF v_viewer IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.location_shares ls
    WHERE ls.from_user_id = p_sharer_id
      AND ls.to_user_id = v_viewer
      AND (ls.expires_at IS NULL OR ls.expires_at > now())
  ) THEN
    RETURN 'not_shared';
  END IF;

  SELECT ul.updated_at INTO v_updated_at
  FROM public.user_locations ul
  WHERE ul.user_id = p_sharer_id;
  IF v_updated_at IS NOT NULL AND v_updated_at > now() - interval '1 minute' THEN
    RETURN 'fresh';
  END IF;

  -- At most one wake per sharer per minute, however many people are looking.
  INSERT INTO public.location_refresh_requests AS r (sharer_id, requested_at)
  VALUES (p_sharer_id, now())
  ON CONFLICT (sharer_id) DO UPDATE
    SET requested_at = excluded.requested_at
    WHERE r.requested_at <= now() - interval '1 minute';
  IF NOT FOUND THEN
    RETURN 'throttled';
  END IF;

  -- Not gated on profiles.push_notifications: the push is silent, and the
  -- sharer already agreed to share their location with this viewer.
  SELECT jsonb_agg(jsonb_build_object('token', dt.token, 'platform', dt.platform))
  INTO v_device_tokens
  FROM public.device_push_tokens dt
  WHERE dt.user_id = p_sharer_id;
  IF v_device_tokens IS NULL THEN
    RETURN 'no_device';
  END IF;

  SELECT decrypted_secret INTO v_anon_key
  FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key' LIMIT 1;
  SELECT decrypted_secret INTO v_apns_edge_fn_url
  FROM vault.decrypted_secrets WHERE name = 'apns_edge_fn_url' LIMIT 1;
  IF v_apns_edge_fn_url IS NULL OR v_anon_key IS NULL THEN
    RETURN 'no_device';
  END IF;

  PERFORM net.http_post(
    url     := v_apns_edge_fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_anon_key,
      'Content-Type',  'application/json'
    ),
    body    := jsonb_build_object(
      'tokens', v_device_tokens,
      'kind', 'location_refresh'
    )
  );
  RETURN 'sent';
END;
$$;

REVOKE ALL ON FUNCTION public.request_location_refresh(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.request_location_refresh(uuid) TO authenticated;
