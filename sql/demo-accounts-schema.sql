-- ============================================================
-- Demo accounts for store screenshots / load testing
-- Run in Supabase SQL Editor after fairshare-schema.sql
-- ============================================================

-- Supabase installs pgcrypto in the extensions schema (not public).
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 1. Flag demo profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_demo_account boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS profiles_is_demo_account_idx
  ON public.profiles (is_demo_account) WHERE is_demo_account;

-- 2. Global app settings (admin writes via SECURITY DEFINER RPCs)
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read app settings" ON public.app_settings;
CREATE POLICY "Authenticated users can read app settings"
  ON public.app_settings FOR SELECT
  USING (auth.uid() IS NOT NULL);

INSERT INTO public.app_settings (key, value)
VALUES ('demo_accounts_visible', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 3. Read visibility flag (any authenticated user)
CREATE OR REPLACE FUNCTION public.get_demo_accounts_visible()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT (value #>> '{}')::boolean FROM public.app_settings WHERE key = 'demo_accounts_visible'),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_demo_accounts_visible() TO authenticated;

-- 4. Admin guard constant
-- Philip Rosedale: a8253eea-e76a-46d1-a92d-6fe36911f038

CREATE OR REPLACE FUNCTION public.admin_get_demo_accounts_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid := 'a8253eea-e76a-46d1-a92d-6fe36911f038';
  v_caller_id uuid := auth.uid();
  v_visible boolean;
  v_count int;
  v_contact_count int;
BEGIN
  IF v_caller_id IS NULL OR v_caller_id != v_admin_id THEN
    RAISE EXCEPTION 'Unauthorized: admin access required';
  END IF;

  v_visible := public.get_demo_accounts_visible();
  SELECT count(*)::int INTO v_count FROM public.profiles WHERE is_demo_account = true;

  SELECT count(*)::int INTO v_contact_count
    FROM public.contacts c
    JOIN public.profiles p ON p.id = c.contact_id
   WHERE c.user_id = v_caller_id
     AND p.is_demo_account = true;

  RETURN jsonb_build_object(
    'visible', v_visible,
    'demo_count', v_count,
    'expected_count', 12,
    'demo_password', 'DemoUnion2026!',
    'auth_email_pattern', 'demo+*@fairshare.social',
    'your_id', v_caller_id,
    'philip_demo_contacts', v_contact_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_demo_accounts_visible(p_visible boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid := 'a8253eea-e76a-46d1-a92d-6fe36911f038';
BEGIN
  IF auth.uid() IS NULL OR auth.uid() != v_admin_id THEN
    RAISE EXCEPTION 'Unauthorized: admin access required';
  END IF;

  INSERT INTO public.app_settings (key, value, updated_at)
  VALUES ('demo_accounts_visible', to_jsonb(p_visible), now())
  ON CONFLICT (key) DO UPDATE
    SET value = to_jsonb(p_visible), updated_at = now();

  RETURN jsonb_build_object('success', true, 'visible', p_visible);
END;
$$;

-- 5. Ensure one demo auth user exists; returns profile id
CREATE OR REPLACE FUNCTION public._demo_ensure_auth_user(
  p_email text,
  p_display_name text,
  p_password text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_user_id uuid;
  v_instance_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(trim(p_email));

  IF v_user_id IS NOT NULL THEN
    RETURN v_user_id;
  END IF;

  v_user_id := gen_random_uuid();
  SELECT id INTO v_instance_id FROM auth.instances LIMIT 1;
  IF v_instance_id IS NULL THEN
    v_instance_id := '00000000-0000-0000-0000-000000000000';
  END IF;

  INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    recovery_sent_at,
    last_sign_in_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
  ) VALUES (
    v_instance_id,
    v_user_id,
    'authenticated',
    'authenticated',
    lower(trim(p_email)),
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    now(),
    now(),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('display_name', p_display_name),
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

  INSERT INTO auth.identities (
    id,
    user_id,
    identity_data,
    provider,
    provider_id,
    last_sign_in_at,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', lower(trim(p_email))),
    'email',
    v_user_id::text,
    now(),
    now(),
    now()
  );

  RETURN v_user_id;
END;
$$;

-- 6. Bidirectional contact helper
CREATE OR REPLACE FUNCTION public._demo_ensure_contact_pair(
  p_user_a uuid,
  p_user_b uuid,
  p_first_met_at timestamptz,
  p_met_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_a = p_user_b THEN
    RETURN;
  END IF;

  INSERT INTO public.contacts (user_id, contact_id, met_at, first_met_at)
  VALUES (p_user_a, p_user_b, p_met_at, p_first_met_at)
  ON CONFLICT (user_id, contact_id) DO UPDATE
    SET met_at = EXCLUDED.met_at,
        first_met_at = COALESCE(contacts.first_met_at, EXCLUDED.first_met_at);

  INSERT INTO public.contacts (user_id, contact_id, met_at, first_met_at)
  VALUES (p_user_b, p_user_a, p_met_at, p_first_met_at)
  ON CONFLICT (user_id, contact_id) DO UPDATE
    SET met_at = EXCLUDED.met_at,
        first_met_at = COALESCE(contacts.first_met_at, EXCLUDED.first_met_at);
END;
$$;

-- 7. Seed all demo accounts (idempotent)
CREATE OR REPLACE FUNCTION public.admin_seed_demo_accounts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_id uuid := 'a8253eea-e76a-46d1-a92d-6fe36911f038';
  v_owner_id uuid := auth.uid();
  v_password text := 'DemoUnion2026!';
  v_your_contacts int := 0;
  v_demo jsonb;
  v_accounts jsonb := '[
    {"slug":"elena-vasquez","display_name":"Elena Vasquez","auth_email":"demo+elena@fairshare.social","contact_email":"elena.vasquez@example.com","phone":"(555) 555-0101","first_met_at":"2019-03-14","met_at":"2026-05-02T14:30:00Z","vouch_weight":"high"},
    {"slug":"marcus-chen","display_name":"Marcus Chen","auth_email":"demo+marcus@fairshare.social","contact_email":"marcus.chen@example.com","phone":"(555) 555-0102","first_met_at":"2015-08-22","met_at":"2026-04-18T09:15:00Z","vouch_weight":"high"},
    {"slug":"priya-nair","display_name":"Priya Nair","auth_email":"demo+priya@fairshare.social","contact_email":"priya.nair@example.com","phone":"(555) 555-0103","first_met_at":"2022-01-09","met_at":"2026-05-10T18:45:00Z","vouch_weight":"medium"},
    {"slug":"james-whitmore","display_name":"James Whitmore","auth_email":"demo+james@fairshare.social","contact_email":"james.whitmore@example.com","phone":"(555) 555-0104","first_met_at":"2011-11-03","met_at":"2026-03-28T11:00:00Z","vouch_weight":"high"},
    {"slug":"sofia-lindgren","display_name":"Sofia Lindgren","auth_email":"demo+sofia@fairshare.social","contact_email":"sofia.lindgren@example.com","phone":"(555) 555-0105","first_met_at":"2024-06-17","met_at":"2026-05-15T08:20:00Z","vouch_weight":"low"},
    {"slug":"david-okonkwo","display_name":"David Okonkwo","auth_email":"demo+david@fairshare.social","contact_email":"david.okonkwo@example.com","phone":"(555) 555-0106","first_met_at":"2020-09-30","met_at":"2026-04-05T16:10:00Z","vouch_weight":"medium"},
    {"slug":"hannah-reeves","display_name":"Hannah Reeves","auth_email":"demo+hannah@fairshare.social","contact_email":"hannah.reeves@example.com","phone":"(555) 555-0107","first_met_at":"2025-02-11","met_at":"2026-05-20T12:00:00Z","vouch_weight":"low"},
    {"slug":"omar-farouk","display_name":"Omar Farouk","auth_email":"demo+omar@fairshare.social","contact_email":"omar.farouk@example.com","phone":"(555) 555-0108","first_met_at":"2017-07-25","met_at":"2026-04-22T19:30:00Z","vouch_weight":"medium"},
    {"slug":"clara-nguyen","display_name":"Clara Nguyen","auth_email":"demo+clara@fairshare.social","contact_email":"clara.nguyen@example.com","phone":"(555) 555-0109","first_met_at":"2023-04-08","met_at":"2026-05-08T10:45:00Z","vouch_weight":"medium"},
    {"slug":"nate-bramwell","display_name":"Nate Bramwell","auth_email":"demo+nate@fairshare.social","contact_email":"nate.bramwell@example.com","phone":"(555) 555-0110","first_met_at":"2026-01-20","met_at":"2026-05-25T07:00:00Z","vouch_weight":"low"},
    {"slug":"zoe-matsumoto","display_name":"Zoe Matsumoto","auth_email":"demo+zoe@fairshare.social","contact_email":"zoe.matsumoto@example.com","phone":"(555) 555-0111","first_met_at":"2021-10-12","met_at":"2026-04-30T15:25:00Z","vouch_weight":"medium"},
    {"slug":"andre-santos","display_name":"Andre Santos","auth_email":"demo+andre@fairshare.social","contact_email":"andre.santos@example.com","phone":"(555) 555-0112","first_met_at":"2018-05-06","met_at":"2026-05-12T13:40:00Z","vouch_weight":"medium"}
  ]'::jsonb;

  v_ids uuid[] := ARRAY[]::uuid[];
  v_slugs text[] := ARRAY[]::text[];
  v_weights text[] := ARRAY[]::text[];
  v_first_mets timestamptz[] := ARRAY[]::timestamptz[];
  v_mets timestamptz[] := ARRAY[]::timestamptz[];
  v_emails text[] := ARRAY[]::text[];
  v_phones text[] := ARRAY[]::text[];

  v_i int;
  v_j int;
  v_k int;
  v_n int;
  v_uid uuid;
  v_first_met timestamptz;
  v_met timestamptz;
  v_weight text;
  v_vouch_count int;
  v_types text[] := ARRAY['trust','trust','respect','help','profile_picture_accurate','love'];
  v_type text;
  v_years_ago double precision;
  v_philip_phone text;
  v_philip_email text;
  v_created int := 0;
  v_updated int := 0;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id != v_admin_id THEN
    RAISE EXCEPTION 'Unauthorized: admin access required';
  END IF;

  SELECT coalesce(pp.phone, '(555) 555-0001'), coalesce(pp.email, 'philip@highfidelity.io')
    INTO v_philip_phone, v_philip_email
    FROM public.profile_private pp WHERE pp.user_id = v_owner_id;

  v_n := jsonb_array_length(v_accounts);

  FOR v_i IN 0..(v_n - 1) LOOP
    v_demo := v_accounts->v_i;
    v_uid := public._demo_ensure_auth_user(
      v_demo->>'auth_email',
      v_demo->>'display_name',
      v_password
    );

    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND is_demo_account = true) THEN
      v_updated := v_updated + 1;
    ELSE
      v_created := v_created + 1;
    END IF;

    UPDATE public.profiles
       SET display_name = v_demo->>'display_name',
           sponsor_id = v_owner_id,
           is_demo_account = true,
           signup_token = NULL,
           profile_image_url = 'https://app.fairshare.social/assets/demo-portraits/'
             || (v_demo->>'slug') || '.jpg'
     WHERE id = v_uid;

    INSERT INTO public.profile_private (user_id, phone, email, updated_at)
    VALUES (v_uid, v_demo->>'phone', v_demo->>'contact_email', now())
    ON CONFLICT (user_id) DO UPDATE
      SET phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          updated_at = now();

    v_ids := array_append(v_ids, v_uid);
    v_slugs := array_append(v_slugs, v_demo->>'slug');
    v_weights := array_append(v_weights, v_demo->>'vouch_weight');
    v_first_mets := array_append(v_first_mets, (v_demo->>'first_met_at')::timestamptz);
    v_mets := array_append(v_mets, (v_demo->>'met_at')::timestamptz);
    v_emails := array_append(v_emails, v_demo->>'contact_email');
    v_phones := array_append(v_phones, v_demo->>'phone');

    PERFORM public._demo_ensure_contact_pair(
      v_owner_id, v_uid,
      (v_demo->>'first_met_at')::timestamptz,
      (v_demo->>'met_at')::timestamptz
    );

    INSERT INTO public.contact_shared (user_id, contact_id, shared_phone, shared_email)
    VALUES (v_uid, v_owner_id, v_demo->>'phone', v_demo->>'contact_email')
    ON CONFLICT (user_id, contact_id) DO UPDATE
      SET shared_phone = EXCLUDED.shared_phone,
          shared_email = EXCLUDED.shared_email;

    INSERT INTO public.contact_shared (user_id, contact_id, shared_phone, shared_email)
    VALUES (v_owner_id, v_uid, v_philip_phone, v_philip_email)
    ON CONFLICT (user_id, contact_id) DO UPDATE
      SET shared_phone = EXCLUDED.shared_phone,
          shared_email = EXCLUDED.shared_email;
  END LOOP;

  -- Demo mesh: every pair connected
  FOR v_i IN 1..v_n LOOP
    FOR v_j IN (v_i + 1)..v_n LOOP
      v_first_met := LEAST(v_first_mets[v_i], v_first_mets[v_j]);
      v_met := GREATEST(v_mets[v_i], v_mets[v_j]);
      PERFORM public._demo_ensure_contact_pair(v_ids[v_i], v_ids[v_j], v_first_met, v_met);
    END LOOP;
  END LOOP;

  -- Clear prior demo-to-demo vouches so re-seed is idempotent
  DELETE FROM public.attestations a
   WHERE a.from_user_id = ANY(v_ids)
     AND a.to_user_id = ANY(v_ids);

  -- Seed vouches among demo accounts
  FOR v_i IN 1..v_n LOOP
    v_weight := v_weights[v_i];
    v_vouch_count := CASE v_weight
      WHEN 'high' THEN 8
      WHEN 'medium' THEN 5
      ELSE 3
    END;

    FOR v_k IN 1..v_vouch_count LOOP
      v_j := ((v_i * 7 + v_k * 3) % v_n) + 1;
      IF v_j = v_i THEN
        v_j := (v_j % v_n) + 1;
      END IF;

      v_type := v_types[((v_i + v_k) % array_length(v_types, 1)) + 1];
      IF v_weight = 'low' AND v_type = 'trust' AND v_k > 1 THEN
        v_type := 'respect';
      END IF;

      v_years_ago := CASE v_weight
        WHEN 'high' THEN 0.5 + (v_k * 0.6)
        WHEN 'medium' THEN 0.2 + (v_k * 0.35)
        ELSE 0.05 + (v_k * 0.15)
      END;

      INSERT INTO public.attestations (from_user_id, to_user_id, attestation_type, created_at)
      VALUES (
        v_ids[v_j],
        v_ids[v_i],
        v_type,
        now() - (v_years_ago * interval '1 year')
      );
    END LOOP;
  END LOOP;

  SELECT count(*)::int INTO v_your_contacts
    FROM public.contacts c
    JOIN public.profiles p ON p.id = c.contact_id
   WHERE c.user_id = v_owner_id
     AND p.is_demo_account = true;

  RETURN jsonb_build_object(
    'success', true,
    'created', v_created,
    'updated', v_updated,
    'total', v_n,
    'your_contacts', v_your_contacts,
    'your_id', v_owner_id,
    'demo_password', v_password,
    'message', 'Click Apply demo portraits in admin if avatars are missing.'
  );
END;
$$;

-- 7a. Repair contact links only (idempotent)
CREATE OR REPLACE FUNCTION public.admin_repair_demo_contacts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_id uuid := 'a8253eea-e76a-46d1-a92d-6fe36911f038';
  v_owner_id uuid := auth.uid();
  v_demo record;
  v_count int := 0;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id != v_admin_id THEN
    RAISE EXCEPTION 'Unauthorized: admin access required';
  END IF;

  FOR v_demo IN
    SELECT p.id, p.created_at AS first_met
      FROM public.profiles p
     WHERE p.is_demo_account = true
  LOOP
    PERFORM public._demo_ensure_contact_pair(
      v_owner_id, v_demo.id, v_demo.first_met, now()
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'linked', v_count, 'your_id', v_owner_id);
END;
$$;

-- 7b. Set profile_image_url from static assets (no service-role upload needed)
CREATE OR REPLACE FUNCTION public.admin_apply_demo_portraits(
  p_origin text DEFAULT 'https://app.fairshare.social'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid := 'a8253eea-e76a-46d1-a92d-6fe36911f038';
  v_origin text := rtrim(coalesce(nullif(trim(p_origin), ''), 'https://app.fairshare.social'), '/');
  v_accounts jsonb := '[
    {"slug":"elena-vasquez","display_name":"Elena Vasquez"},
    {"slug":"marcus-chen","display_name":"Marcus Chen"},
    {"slug":"priya-nair","display_name":"Priya Nair"},
    {"slug":"james-whitmore","display_name":"James Whitmore"},
    {"slug":"sofia-lindgren","display_name":"Sofia Lindgren"},
    {"slug":"david-okonkwo","display_name":"David Okonkwo"},
    {"slug":"hannah-reeves","display_name":"Hannah Reeves"},
    {"slug":"omar-farouk","display_name":"Omar Farouk"},
    {"slug":"clara-nguyen","display_name":"Clara Nguyen"},
    {"slug":"nate-bramwell","display_name":"Nate Bramwell"},
    {"slug":"zoe-matsumoto","display_name":"Zoe Matsumoto"},
    {"slug":"andre-santos","display_name":"Andre Santos"}
  ]'::jsonb;
  v_demo jsonb;
  v_i int;
  v_n int;
  v_updated int := 0;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() != v_admin_id THEN
    RAISE EXCEPTION 'Unauthorized: admin access required';
  END IF;

  v_n := jsonb_array_length(v_accounts);
  FOR v_i IN 0..(v_n - 1) LOOP
    v_demo := v_accounts->v_i;
    UPDATE public.profiles
       SET profile_image_url = v_origin || '/assets/demo-portraits/'
         || (v_demo->>'slug') || '.jpg'
     WHERE is_demo_account = true
       AND display_name = v_demo->>'display_name';
    v_updated := v_updated + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'updated', v_updated,
    'origin', v_origin,
    'sample_url', v_origin || '/assets/demo-portraits/elena-vasquez.jpg'
  );
END;
$$;

-- 8. Pre-warm trust scores for Philip's demo contacts
CREATE OR REPLACE FUNCTION public.admin_refresh_demo_trust_scores()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid := 'a8253eea-e76a-46d1-a92d-6fe36911f038';
  v_owner_id uuid := auth.uid();
  v_demo_id uuid;
  v_count int := 0;
  v_result json;
BEGIN
  IF v_owner_id IS NULL OR v_owner_id != v_admin_id THEN
    RAISE EXCEPTION 'Unauthorized: admin access required';
  END IF;

  FOR v_demo_id IN
    SELECT c.contact_id
      FROM public.contacts c
      JOIN public.profiles p ON p.id = c.contact_id
     WHERE c.user_id = v_owner_id
       AND p.is_demo_account = true
  LOOP
    v_result := public.get_contact_trust_summary(v_demo_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'refreshed', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_get_demo_accounts_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_demo_accounts_visible(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seed_demo_accounts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_refresh_demo_trust_scores() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_apply_demo_portraits(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_repair_demo_contacts() TO authenticated;

-- Refresh PostgREST schema cache so new RPCs are visible immediately
NOTIFY pgrst, 'reload schema';
