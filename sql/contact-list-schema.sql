-- Contact list & preferences schema for FairShare
-- Run this in Supabase SQL Editor.

-- 1. Extend profiles (phone, email, profile_image_url)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_image_url text;

-- 2. Extend contacts (created_at, selfie_url, first_met_at, notify_nearby)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS selfie_url text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_met_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notify_nearby boolean DEFAULT false;

-- 2b. Allow users to update their own contacts rows (needed for selfie_url, etc.)
DROP POLICY IF EXISTS "Users can update own contacts" ON contacts;
CREATE POLICY "Users can update own contacts"
  ON contacts FOR UPDATE USING (auth.uid() = user_id);

-- 2c. RPC: set selfie on both sides of a contact pair (SECURITY DEFINER to bypass RLS)
CREATE OR REPLACE FUNCTION set_contact_selfie(p_contact_id uuid, p_selfie_url text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE contacts SET selfie_url = p_selfie_url
  WHERE (user_id = auth.uid() AND contact_id = p_contact_id)
     OR (user_id = p_contact_id AND contact_id = auth.uid());
END;
$$;

-- 3. contact_shared: what each user has shared with each contact
CREATE TABLE IF NOT EXISTS contact_shared (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shared_phone text,
  shared_email text,
  PRIMARY KEY (user_id, contact_id)
);

ALTER TABLE contact_shared ENABLE ROW LEVEL SECURITY;

-- Sharer can do everything; recipient can only read (to see what was shared with them)
DROP POLICY IF EXISTS "Users manage own shared data" ON contact_shared;
DROP POLICY IF EXISTS "Users read shared with them" ON contact_shared;
CREATE POLICY "Users manage own shared data" ON contact_shared
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own shared data" ON contact_shared
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users delete own shared data" ON contact_shared
  FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Users read shared with them" ON contact_shared
  FOR SELECT USING (auth.uid() = user_id OR auth.uid() = contact_id);

-- 4. contact_shares: for Realtime "X shared Y with you" toasts
CREATE TABLE IF NOT EXISTS contact_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shared_type text NOT NULL CHECK (shared_type IN ('phone', 'email')),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE contact_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users insert own shares" ON contact_shares;
CREATE POLICY "Users insert own shares" ON contact_shares
  FOR INSERT WITH CHECK (auth.uid() = from_user_id);

DROP POLICY IF EXISTS "Users read received shares" ON contact_shares;
CREATE POLICY "Users read received shares" ON contact_shares
  FOR SELECT USING (auth.uid() = to_user_id);

-- After running this: enable Realtime for contact_shares in Dashboard → Database → Replication.

-- 5. profiles: allow reading display_name (etc.) of your contacts so contact list shows names
--    Run this if contact names show as "Unknown" (RLS was blocking read of other users' profiles).
DROP POLICY IF EXISTS "Users can read profiles of contacts" ON profiles;
CREATE POLICY "Users can read profiles of contacts" ON profiles
  FOR SELECT USING (
    id = auth.uid()
    OR id IN (SELECT contact_id FROM contacts WHERE contacts.user_id = auth.uid())
  );
-- If you already have a policy like "Users can read own profile" (SELECT where id = auth.uid()),
-- you may need to drop it and use this combined one, or add this as an additional SELECT policy
-- only if your RLS allows multiple policies for the same command (OR together).

-- 7. contact_selfies: multiple selfies per contact pair with GPS metadata
CREATE TABLE IF NOT EXISTS contact_selfies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  selfie_url     text NOT NULL,
  captured_at    timestamptz DEFAULT now(),
  lat            double precision,
  lng            double precision,
  location_label text,
  created_at     timestamptz DEFAULT now()
);

ALTER TABLE contact_selfies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own selfies" ON contact_selfies;
CREATE POLICY "Users read own selfies" ON contact_selfies
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own selfies" ON contact_selfies;
CREATE POLICY "Users insert own selfies" ON contact_selfies
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- RPC: insert a selfie row for both sides of the contact pair (SECURITY DEFINER bypasses RLS for the other side)
CREATE OR REPLACE FUNCTION add_contact_selfie(
  p_contact_id    uuid,
  p_selfie_url    text,
  p_captured_at   timestamptz DEFAULT now(),
  p_lat           double precision DEFAULT NULL,
  p_lng           double precision DEFAULT NULL,
  p_location_label text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_name      text;
  v_msg       text;
BEGIN
  -- Row for the caller
  INSERT INTO contact_selfies (user_id, contact_id, selfie_url, captured_at, lat, lng, location_label)
  VALUES (v_caller_id, p_contact_id, p_selfie_url, p_captured_at, p_lat, p_lng, p_location_label);

  -- Mirrored row for the contact so they also see the selfie
  INSERT INTO contact_selfies (user_id, contact_id, selfie_url, captured_at, lat, lng, location_label)
  VALUES (p_contact_id, v_caller_id, p_selfie_url, p_captured_at, p_lat, p_lng, p_location_label);

  -- Update contacts.selfie_url for both sides so the Realtime UPDATE triggers UI refresh for the recipient
  UPDATE contacts SET selfie_url = p_selfie_url
  WHERE (user_id = v_caller_id AND contact_id = p_contact_id)
     OR (user_id = p_contact_id AND contact_id = v_caller_id);

  -- Notify the contact via in-app notification and Web Push
  SELECT display_name INTO v_name FROM public.profiles WHERE id = v_caller_id;
  v_msg := coalesce(v_name, 'Someone') || ' took a new selfie with you.';

  INSERT INTO public.contact_notifications (to_user_id, from_user_id, notification_type, message)
  VALUES (p_contact_id, v_caller_id, 'new_selfie', v_msg);

  -- Deep-link the push so tapping the OS notification opens the caller's
  -- contact details screen (handled in push.js handleNotificationNavigation).
  PERFORM public.send_push_to_users(
    ARRAY[p_contact_id], v_caller_id, 'Union', v_msg,
    '/?action=view_contact&contact=' || v_caller_id::text
  );
END;
$$;

-- =============================================================================
-- Reset contacts (for testing): run in SQL Editor to delete all contact data
-- =============================================================================
-- DELETE FROM contact_shares;
-- DELETE FROM contact_shared;
-- DELETE FROM contacts;
-- DELETE FROM contact_selfies;

-- 6. Shared trust helpers for contact detail
--    Aggregates only; does not expose full social graph rows to clients.

-- Count mutual contacts between caller and p_contact_id.
-- Excludes the caller and p_contact_id from the shared set.
CREATE OR REPLACE FUNCTION public.get_shared_contacts_count(p_contact_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_count integer := 0;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'You must be logged in';
  END IF;

  IF p_contact_id IS NULL THEN
    RAISE EXCEPTION 'Contact is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.contacts
    WHERE user_id = v_caller_id
      AND contact_id = p_contact_id
  ) THEN
    RAISE EXCEPTION 'You can only view shared trust for your contacts';
  END IF;

  SELECT COUNT(DISTINCT c1.contact_id)
  INTO v_count
  FROM public.contacts c1
  JOIN public.contacts c2
    ON c1.contact_id = c2.contact_id
  WHERE c1.user_id = v_caller_id
    AND c2.user_id = p_contact_id
    AND c1.contact_id NOT IN (v_caller_id, p_contact_id);

  RETURN COALESCE(v_count, 0);
END;
$$;

-- Return mutual contacts between caller and p_contact_id (id + display_name).
CREATE OR REPLACE FUNCTION public.get_shared_contacts(p_contact_id uuid)
RETURNS TABLE (
  id uuid,
  display_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
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
    SELECT 1
    FROM public.contacts
    WHERE user_id = v_caller_id
      AND contact_id = p_contact_id
  ) THEN
    RAISE EXCEPTION 'You can only view shared trust for your contacts';
  END IF;

  RETURN QUERY
  SELECT DISTINCT p.id, p.display_name
  FROM public.contacts c1
  JOIN public.contacts c2
    ON c1.contact_id = c2.contact_id
  JOIN public.profiles p
    ON p.id = c1.contact_id
  WHERE c1.user_id = v_caller_id
    AND c2.user_id = p_contact_id
    AND c1.contact_id NOT IN (v_caller_id, p_contact_id)
  ORDER BY p.display_name;
END;
$$;

-- List groups where both caller and p_contact_id are active members.
CREATE OR REPLACE FUNCTION public.get_shared_groups(p_contact_id uuid)
RETURNS TABLE (
  id uuid,
  name text
)
LANGUAGE plpgsql
SECURITY DEFINER
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
    SELECT 1
    FROM public.contacts
    WHERE user_id = v_caller_id
      AND contact_id = p_contact_id
  ) THEN
    RAISE EXCEPTION 'You can only view shared trust for your contacts';
  END IF;

  RETURN QUERY
  SELECT DISTINCT g.id, g.name
  FROM public.members m1
  JOIN public.members m2
    ON m1.group_id = m2.group_id
  JOIN public.groups g
    ON g.id = m1.group_id
  WHERE m1.user_id = v_caller_id
    AND m2.user_id = p_contact_id
    AND m1.status = 'active'
    AND m2.status = 'active'
  ORDER BY g.name, g.id;
END;
$$;
