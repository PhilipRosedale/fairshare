-- Reserve meet_requests.used_by at signup so the handshake token cannot be
-- consumed by a third party between account creation and first login.
-- Run in Supabase SQL Editor.

-- 1. handle_new_user: reserve the meet token for the new account
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_meet_token   text := new.raw_user_meta_data->>'meet_token';
  v_invite_token text := new.raw_user_meta_data->>'invite_token';
  v_token        text;
  v_sponsor_id   uuid;
BEGIN
  IF v_meet_token IS NOT NULL THEN
    SELECT user_id INTO v_sponsor_id
    FROM public.meet_requests
    WHERE token = v_meet_token
      AND expires_at > now()
      AND used_by IS NULL;
    IF v_sponsor_id IS NULL THEN
      RAISE EXCEPTION 'Handshake link is invalid, expired, or already used';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles WHERE signup_token = v_meet_token) THEN
      RAISE EXCEPTION 'This handshake has already been used to create an account';
    END IF;
    v_token := v_meet_token;
    UPDATE public.meet_requests
    SET used_by = new.id
    WHERE token = v_meet_token;
  ELSIF v_invite_token IS NOT NULL THEN
    SELECT sponsor_id INTO v_sponsor_id
    FROM public.sponsorships
    WHERE token = v_invite_token
      AND status = 'pending'
      AND expires_at > now();
    IF v_sponsor_id IS NULL THEN
      RAISE EXCEPTION 'Invitation is invalid, expired, or already used';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles WHERE signup_token = v_invite_token) THEN
      RAISE EXCEPTION 'This invitation has already been used to create an account';
    END IF;
    v_token := v_invite_token;
  END IF;

  INSERT INTO public.profiles (id, display_name, sponsor_id, signup_token)
  VALUES (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    v_sponsor_id,
    v_token
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 2. complete_meet: allow the reserved caller to finish the handshake
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
