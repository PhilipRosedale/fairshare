-- Tell an invitee who is waiting on their confirmation email that they are
-- almost done, instead of that their handshake link is already used.
--
-- handle_new_user() reserves meet_requests.used_by at account creation (see
-- meet-token-reserve-at-signup.sql). That is what stops a third party from
-- consuming the handshake during the email-confirmation window, and it should
-- stay. The side effect is that get_meet_by_token() begins reporting
-- "This meet link has already been used" the moment the invitee signs up.
--
-- So: invitee scans, signs up, goes to their mail app, and taps the original
-- link again while looking for the confirmation mail -- which is the single
-- most likely thing for them to do, since the link is right there in the
-- message their sponsor sent. They are told the link is spent, the client
-- clears the stored token, and the signup gate re-locks.
--
-- Their account is fine either way: the token also rides in auth
-- user_metadata, so complete_meet() still runs on first login. This is purely
-- a false alarm, and it lands at the most fragile moment of onboarding.
--
-- Fix: distinguish "reserved by the account this very token created" from
-- "consumed by somebody else" and return a distinct, non-alarming status.
-- profiles.signup_token is UNIQUE (sponsor-id-at-signup.sql), so the match is
-- exact -- there is no way for two accounts to answer to one token.

CREATE OR REPLACE FUNCTION public.get_meet_by_token(p_token text)
RETURNS json AS $$
DECLARE
  v_meet record;
  v_name text;
  v_profile_image_url text;
  v_phone text;
  v_email text;
  v_group_name text;
  v_result json;
BEGIN
  SELECT * INTO v_meet
  FROM public.meet_requests
  WHERE token = p_token
    AND expires_at > now();

  IF NOT FOUND THEN
    RETURN json_build_object('error', 'Meet request not found or expired');
  END IF;

  IF v_meet.used_by IS NOT NULL THEN
    -- Was this handshake reserved by the account it created, rather than
    -- consumed by a third party? Then the invitee is mid-signup, not late.
    IF EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = v_meet.used_by
        AND signup_token = p_token
    ) THEN
      RETURN json_build_object(
        'status', 'awaiting_confirmation',
        'message', 'You have already signed up with this link. Check your email to confirm your account, then log in.'
      );
    END IF;

    RETURN json_build_object('error', 'This meet link has already been used');
  END IF;

  SELECT display_name, profile_image_url, phone, email
    INTO v_name, v_profile_image_url, v_phone, v_email
  FROM public.profiles
  WHERE id = v_meet.user_id;

  v_result := json_build_object(
    'user_name', COALESCE(v_name, 'A Union member'),
    'profile_image_url', v_profile_image_url,
    'phone', CASE WHEN v_meet.share_phone THEN v_phone ELSE NULL END,
    'email', CASE WHEN v_meet.share_email THEN v_email ELSE NULL END
  );

  IF v_meet.group_id IS NOT NULL THEN
    SELECT name INTO v_group_name
    FROM public.groups WHERE id = v_meet.group_id;

    v_result := json_build_object(
      'user_name', COALESCE(v_name, 'A Union member'),
      'profile_image_url', v_profile_image_url,
      'phone', CASE WHEN v_meet.share_phone THEN v_phone ELSE NULL END,
      'email', CASE WHEN v_meet.share_email THEN v_email ELSE NULL END,
      'group_name', v_group_name,
      'message', v_meet.message
    );
  END IF;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
