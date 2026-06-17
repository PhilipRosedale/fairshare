-- Contact intro + how-you-met (F2F / URL / Intro) — run in Supabase SQL Editor.
-- Merges notification_type enum with existing app values and extends complete_meet.

-- -----------------------------------------------------------------------------
-- 1. contacts: met_via + introduced_by_user_id
-- -----------------------------------------------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS met_via text;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS introduced_by_user_id uuid REFERENCES public.profiles(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_met_via_check'
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_met_via_check
      CHECK (met_via IS NULL OR met_via IN ('F2F', 'URL', 'Intro'));
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. contact_intros (server-only via SECURITY DEFINER RPCs)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_intros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  introducer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_a_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_b_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_intros_distinct CHECK (contact_a_id <> contact_b_id),
  CONSTRAINT contact_intros_no_self CHECK (
    introducer_id IS DISTINCT FROM contact_a_id
    AND introducer_id IS DISTINCT FROM contact_b_id
  )
);

CREATE INDEX IF NOT EXISTS contact_intros_introducer_idx
  ON public.contact_intros (introducer_id, created_at DESC);

ALTER TABLE public.contact_intros ENABLE ROW LEVEL SECURITY;

-- No broad policies: reads/writes only through SECURITY DEFINER functions.

-- -----------------------------------------------------------------------------
-- 3. contact_notifications: add contact_intro
-- -----------------------------------------------------------------------------
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
    'new_selfie',
    'location_share_started',
    'new_contact',
    'display_name_changed',
    'contact_intro'
  ));

-- -----------------------------------------------------------------------------
-- 4. complete_meet(p_token, p_meet_source) — preserve met_via on conflict
-- -----------------------------------------------------------------------------
-- Remove legacy single-argument overload so clients may call with just p_token
-- (second parameter defaults to URL).
DROP FUNCTION IF EXISTS public.complete_meet(text);

CREATE OR REPLACE FUNCTION public.complete_meet(
  p_token text,
  p_meet_source text DEFAULT 'URL'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_meet_request record;
  v_contact_name text;
  v_caller_name text;
  v_caller_signup_token text;
  v_caller_sponsor uuid;
  v_group_name text;
  v_admitted boolean;
  v_is_new_account boolean;
  v_push_msg text;
  v_already_contact boolean;
  v_src text;
BEGIN
  v_src := upper(nullif(trim(coalesce(p_meet_source, '')), ''));
  IF v_src IS NULL OR v_src NOT IN ('F2F', 'URL') THEN
    v_src := 'URL';
  END IF;

  SELECT * INTO v_meet_request
  FROM public.meet_requests
  WHERE token = p_token
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meet request not found or expired';
  END IF;

  IF v_meet_request.used_by IS NOT NULL AND v_meet_request.used_by <> v_caller_id THEN
    RAISE EXCEPTION 'This meet link has already been used';
  END IF;

  IF v_meet_request.user_id = v_caller_id THEN
    RAISE EXCEPTION 'Cannot create a contact with yourself';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.contacts
    WHERE user_id = v_caller_id AND contact_id = v_meet_request.user_id
  ) INTO v_already_contact;

  IF v_meet_request.used_by IS NULL THEN
    UPDATE public.meet_requests
    SET used_by = v_caller_id
    WHERE id = v_meet_request.id;
  END IF;

  SELECT sponsor_id INTO v_caller_sponsor
  FROM public.profiles
  WHERE id = v_caller_id;

  IF v_caller_sponsor IS NULL THEN
    UPDATE public.profiles
    SET sponsor_id = v_meet_request.user_id
    WHERE id = v_caller_id;
  END IF;

  INSERT INTO public.contacts (user_id, contact_id, met_at, met_via, first_met_at)
  VALUES (v_caller_id, v_meet_request.user_id, now(), v_src, now())
  ON CONFLICT (user_id, contact_id) DO UPDATE SET met_at = now();

  INSERT INTO public.contacts (user_id, contact_id, met_at, met_via, first_met_at)
  VALUES (v_meet_request.user_id, v_caller_id, now(), v_src, now())
  ON CONFLICT (user_id, contact_id) DO UPDATE SET met_at = now();

  SELECT display_name INTO v_contact_name
  FROM public.profiles
  WHERE id = v_meet_request.user_id;

  SELECT display_name, signup_token
    INTO v_caller_name, v_caller_signup_token
  FROM public.profiles
  WHERE id = v_caller_id;

  v_is_new_account := (v_caller_signup_token IS NOT NULL
                       AND v_caller_signup_token = p_token);

  v_push_msg := COALESCE(v_caller_name, 'Someone')
              || CASE
                   WHEN v_is_new_account
                     THEN ' just joined Union via your handshake.'
                   ELSE ' is now your contact.'
                 END;

  INSERT INTO public.contact_notifications
    (to_user_id, from_user_id, notification_type, message)
  VALUES
    (v_meet_request.user_id, v_caller_id, 'new_contact', v_push_msg);

  PERFORM public.send_push_to_users(
    ARRAY[v_meet_request.user_id],
    v_caller_id,
    'Union',
    v_push_msg,
    '/?action=view_contact&contact=' || v_caller_id::text
  );

  IF v_meet_request.group_id IS NOT NULL THEN

    IF EXISTS (
      SELECT 1 FROM public.members
      WHERE group_id = v_meet_request.group_id
        AND user_id = v_caller_id
        AND status IN ('active', 'pending')
    ) THEN
      RAISE EXCEPTION 'You are already a member or pending candidate of this group';
    END IF;

    INSERT INTO public.members (group_id, user_id, status, balance)
    VALUES (v_meet_request.group_id, v_caller_id, 'pending', 0);

    INSERT INTO public.group_events (group_id, event_type, summary, actor_id, metadata)
    VALUES (
      v_meet_request.group_id,
      'member_sponsored',
      'New candidate '
        || (SELECT display_name FROM public.profiles WHERE id = v_caller_id)
        || ', sponsored by '
        || COALESCE(v_contact_name, 'Unknown'),
      v_meet_request.user_id,
      json_build_object('sponsor_id', v_meet_request.user_id, 'candidate_id', v_caller_id)::jsonb
    );

    INSERT INTO public.endorsements (group_id, candidate_id, endorser_id)
    VALUES (v_meet_request.group_id, v_caller_id, v_meet_request.user_id);

    PERFORM public.check_endorsements(v_meet_request.group_id, v_caller_id);

    SELECT name INTO v_group_name
    FROM public.groups WHERE id = v_meet_request.group_id;

    SELECT (status = 'active') INTO v_admitted
    FROM public.members
    WHERE group_id = v_meet_request.group_id AND user_id = v_caller_id;

    RETURN json_build_object(
      'contact_id', v_meet_request.user_id,
      'contact_name', COALESCE(v_contact_name, 'Unknown'),
      'group_id', v_meet_request.group_id,
      'group_name', v_group_name,
      'admitted', COALESCE(v_admitted, false),
      'already_contact', COALESCE(v_already_contact, false)
    );
  END IF;

  RETURN json_build_object(
    'contact_id', v_meet_request.user_id,
    'contact_name', COALESCE(v_contact_name, 'Unknown'),
    'already_contact', COALESCE(v_already_contact, false)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. get_contact_history — add "intro" timeline row
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_contact_history(
  p_contact_id uuid,
  p_limit int DEFAULT 6
)
RETURNS TABLE (
  id text,
  kind text,
  text text,
  occurred_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'You must be logged in';
  END IF;

  IF p_contact_id IS NULL THEN
    RAISE EXCEPTION 'Contact is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.contacts
    WHERE user_id = v_caller_id AND contact_id = p_contact_id
  ) THEN
    RAISE EXCEPTION 'You can only view history for your contacts';
  END IF;

  RETURN QUERY
  WITH events AS (
    SELECT
      ('n:' || cn.id::text)        AS id,
      'nearby'::text               AS kind,
      CASE
        WHEN cn.location_label IS NOT NULL AND cn.location_label <> ''
          THEN 'Nearby together in ' || cn.location_label
        ELSE 'Nearby together'
      END                          AS text,
      cn.created_at                AS occurred_at
    FROM public.contact_notifications cn
    WHERE cn.notification_type = 'nearby_alert'
      AND (
        (cn.to_user_id = v_caller_id   AND cn.from_user_id = p_contact_id) OR
        (cn.to_user_id = p_contact_id  AND cn.from_user_id = v_caller_id)
      )

    UNION ALL

    SELECT
      ('s:' || cs.id::text)        AS id,
      'selfie'::text               AS kind,
      CASE
        WHEN cs.location_label IS NOT NULL AND cs.location_label <> ''
          THEN 'Selfie together in ' || cs.location_label
        ELSE 'Selfie together'
      END                          AS text,
      cs.captured_at               AS occurred_at
    FROM public.contact_selfies cs
    WHERE cs.user_id = v_caller_id AND cs.contact_id = p_contact_id

    UNION ALL

    SELECT
      ('v:' || a.id::text)         AS id,
      'vouch'::text                AS kind,
      ('You vouched (' || a.attestation_type || ')') AS text,
      a.created_at                 AS occurred_at
    FROM public.attestations a
    WHERE a.from_user_id = v_caller_id
      AND a.to_user_id   = p_contact_id

    UNION ALL

    SELECT
      ('g:' || g.id::text)         AS id,
      'group'::text                AS kind,
      ('Both in ' || g.name)       AS text,
      GREATEST(m1.joined_at, m2.joined_at) AS occurred_at
    FROM public.members m1
    JOIN public.members m2
      ON m1.group_id = m2.group_id
    JOIN public.groups g
      ON g.id = m1.group_id
    WHERE m1.user_id = v_caller_id
      AND m2.user_id = p_contact_id
      AND m1.status = 'active'
      AND m2.status = 'active'

    UNION ALL

    -- Recipient accepted an intro: how this contact was linked to you.
    SELECT
      ('i:' || c.id::text)         AS id,
      'intro'::text                AS kind,
      ('Introduced by ' || COALESCE(pb.display_name, 'Someone')) AS text,
      COALESCE(c.first_met_at, c.met_at, c.created_at) AS occurred_at
    FROM public.contacts c
    LEFT JOIN public.profiles pb ON pb.id = c.introduced_by_user_id
    WHERE c.user_id = v_caller_id
      AND c.contact_id = p_contact_id
      AND c.introduced_by_user_id IS NOT NULL

    UNION ALL

    -- Introducer sent an intro involving this contact (one row per intro sent).
    SELECT
      ('ci:' || ci.id::text)       AS id,
      'intro'::text                AS kind,
      ('Introduced to ' || COALESCE(po.display_name, 'Someone')) AS text,
      ci.created_at                AS occurred_at
    FROM public.contact_intros ci
    JOIN public.profiles po ON po.id = CASE
      WHEN ci.contact_a_id = p_contact_id THEN ci.contact_b_id
      ELSE ci.contact_a_id
    END
    WHERE ci.introducer_id = v_caller_id
      AND (ci.contact_a_id = p_contact_id OR ci.contact_b_id = p_contact_id)
  )
  SELECT events.id, events.kind, events.text, events.occurred_at
  FROM events
  ORDER BY events.occurred_at DESC
  LIMIT GREATEST(COALESCE(p_limit, 6), 1);
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. send_contact_intro
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_contact_intro(
  p_contact_a uuid,
  p_contact_b uuid,
  p_message text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_msg text := trim(coalesce(p_message, ''));
  v_intro_id uuid;
  v_name_intro text;
  v_name_a text;
  v_name_b text;
  v_body_a text;
  v_body_b text;
  v_url text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be logged in';
  END IF;

  IF v_msg = '' THEN
    RAISE EXCEPTION 'Introductory text is required';
  END IF;

  IF p_contact_a IS NULL OR p_contact_b IS NULL OR p_contact_a = p_contact_b THEN
    RAISE EXCEPTION 'Invalid contacts';
  END IF;

  IF p_contact_a = v_uid OR p_contact_b = v_uid THEN
    RAISE EXCEPTION 'Cannot intro yourself';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.contacts
    WHERE user_id = v_uid AND contact_id = p_contact_a
  ) OR NOT EXISTS (
    SELECT 1 FROM public.contacts
    WHERE user_id = v_uid AND contact_id = p_contact_b
  ) THEN
    RAISE EXCEPTION 'You can only intro people in your contact list';
  END IF;

  SELECT display_name INTO v_name_intro FROM public.profiles WHERE id = v_uid;
  SELECT display_name INTO v_name_a FROM public.profiles WHERE id = p_contact_a;
  SELECT display_name INTO v_name_b FROM public.profiles WHERE id = p_contact_b;

  INSERT INTO public.contact_intros (introducer_id, contact_a_id, contact_b_id, message)
  VALUES (v_uid, p_contact_a, p_contact_b, v_msg)
  RETURNING id INTO v_intro_id;

  v_url := '/?action=contact_intro&intro=' || v_intro_id::text;

  v_body_a := COALESCE(v_name_intro, 'Someone')
    || ' wants you to meet '
    || COALESCE(v_name_b, 'Someone');

  v_body_b := COALESCE(v_name_intro, 'Someone')
    || ' wants you to meet '
    || COALESCE(v_name_a, 'Someone');

  INSERT INTO public.contact_notifications
    (to_user_id, from_user_id, notification_type, message, data)
  VALUES (
    p_contact_a,
    v_uid,
    'contact_intro',
    v_body_a,
    jsonb_build_object(
      'intro_id', v_intro_id,
      'other_user_id', p_contact_b,
      'intro_text', v_msg
    )
  );

  INSERT INTO public.contact_notifications
    (to_user_id, from_user_id, notification_type, message, data)
  VALUES (
    p_contact_b,
    v_uid,
    'contact_intro',
    v_body_b,
    jsonb_build_object(
      'intro_id', v_intro_id,
      'other_user_id', p_contact_a,
      'intro_text', v_msg
    )
  );

  PERFORM public.send_push_to_users(
    ARRAY[p_contact_a],
    v_uid,
    'Union',
    v_body_a,
    v_url
  );

  PERFORM public.send_push_to_users(
    ARRAY[p_contact_b],
    v_uid,
    'Union',
    v_body_b,
    v_url
  );

  RETURN json_build_object('intro_id', v_intro_id);
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. get_contact_intro_dialog
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_contact_intro_dialog(p_intro_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  r record;
  v_other uuid;
  v_connected boolean;
  v_intro_name text;
  v_other_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be logged in';
  END IF;

  IF p_intro_id IS NULL THEN
    RAISE EXCEPTION 'Intro is required';
  END IF;

  SELECT * INTO r
  FROM public.contact_intros
  WHERE id = p_intro_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Intro not found';
  END IF;

  IF v_uid <> r.contact_a_id AND v_uid <> r.contact_b_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_other := CASE WHEN v_uid = r.contact_a_id THEN r.contact_b_id ELSE r.contact_a_id END;

  SELECT EXISTS (
    SELECT 1 FROM public.contacts
    WHERE user_id = v_uid AND contact_id = v_other
  ) INTO v_connected;

  SELECT display_name INTO v_intro_name
  FROM public.profiles WHERE id = r.introducer_id;

  SELECT display_name INTO v_other_name
  FROM public.profiles WHERE id = v_other;

  RETURN json_build_object(
    'intro_id', r.id,
    'intro_text', r.message,
    'introducer_id', r.introducer_id,
    'introducer_display_name', COALESCE(v_intro_name, 'Someone'),
    'other_user_id', v_other,
    'other_display_name', COALESCE(v_other_name, 'Someone'),
    'already_connected', v_connected
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. accept_contact_intro
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_contact_intro(p_intro_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  r record;
  v_other uuid;
  v_introducer uuid;
  v_connected boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be logged in';
  END IF;

  IF p_intro_id IS NULL THEN
    RAISE EXCEPTION 'Intro is required';
  END IF;

  SELECT * INTO r
  FROM public.contact_intros
  WHERE id = p_intro_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Intro not found';
  END IF;

  IF v_uid <> r.contact_a_id AND v_uid <> r.contact_b_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_other := CASE WHEN v_uid = r.contact_a_id THEN r.contact_b_id ELSE r.contact_a_id END;
  v_introducer := r.introducer_id;

  SELECT EXISTS (
    SELECT 1 FROM public.contacts
    WHERE user_id = v_uid AND contact_id = v_other
  ) INTO v_connected;

  IF v_connected THEN
    RETURN json_build_object(
      'already_connected', true,
      'other_user_id', v_other,
      'introducer_id', v_introducer
    );
  END IF;

  INSERT INTO public.contacts (user_id, contact_id, met_at, met_via, introduced_by_user_id, first_met_at)
  VALUES (v_uid, v_other, now(), 'Intro', v_introducer, now());

  INSERT INTO public.contacts (user_id, contact_id, met_at, met_via, introduced_by_user_id, first_met_at)
  VALUES (v_other, v_uid, now(), 'Intro', v_introducer, now());

  RETURN json_build_object(
    'already_connected', false,
    'other_user_id', v_other,
    'introducer_id', v_introducer
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_meet(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_contact_intro(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_contact_intro_dialog(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_contact_intro(uuid) TO authenticated;
