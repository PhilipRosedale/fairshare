-- Display-name change: push + in-app contact_notifications for everyone who
-- lists this user as a contact.
--
-- Run in Supabase SQL Editor after migrations that define the current
-- `contact_notifications_notification_type_check` (e.g. contact-intro-and-met-via-migration.sql).

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
    'display_name_changed'
  ));

CREATE OR REPLACE FUNCTION public.notify_contacts_of_display_name_change(
  p_actor_id uuid,
  p_old_display_name text,
  p_new_display_name text
)
RETURNS void AS $$
DECLARE
  v_old text;
  v_new text;
  v_msg text;
  v_contact_ids uuid[];
  v_cid uuid;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  v_old := coalesce(nullif(btrim(p_old_display_name), ''), 'Someone');
  v_new := coalesce(nullif(btrim(p_new_display_name), ''), 'Someone');

  IF v_old = v_new THEN
    RETURN;
  END IF;

  v_msg := v_old || ' changed their name to ' || v_new;

  SELECT array_agg(user_id) INTO v_contact_ids
  FROM public.contacts
  WHERE contact_id = p_actor_id;

  IF v_contact_ids IS NULL OR cardinality(v_contact_ids) = 0 THEN
    RETURN;
  END IF;

  FOREACH v_cid IN ARRAY v_contact_ids LOOP
    INSERT INTO public.contact_notifications (to_user_id, from_user_id, notification_type, message, data)
    VALUES (
      v_cid,
      p_actor_id,
      'display_name_changed',
      v_msg,
      jsonb_build_object('old_display_name', v_old, 'new_display_name', v_new)
    );
  END LOOP;

  PERFORM public.send_push_to_users(
    v_contact_ids,
    p_actor_id,
    'Union',
    v_msg,
    '/?action=view_contact&contact=' || p_actor_id::text
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
