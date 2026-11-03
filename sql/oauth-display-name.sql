-- Social sign-in (Google) users arrive with their name under full_name / name
-- in raw_user_meta_data, not display_name, so the profile trigger was falling
-- back to the email prefix ("glow2601"). Prefer the real name when present.
-- Everything else in handle_new_user is unchanged from
-- sql/meet-token-reserve-at-signup.sql.
-- Run in Supabase SQL Editor.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_meet_token   text := new.raw_user_meta_data->>'meet_token';
  v_invite_token text := new.raw_user_meta_data->>'invite_token';
  v_token        text;
  v_sponsor_id   uuid;
  v_name         text;
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

  v_name := nullif(trim(coalesce(
    new.raw_user_meta_data->>'display_name',
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'name'
  )), '');
  IF v_name IS NULL THEN
    v_name := split_part(new.email, '@', 1);
  END IF;

  INSERT INTO public.profiles (id, display_name, sponsor_id, signup_token)
  VALUES (new.id, v_name, v_sponsor_id, v_token);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
