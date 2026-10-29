-- ============================================================
-- Security fix (Critical): profile PII + membership balance mint
-- ============================================================
-- 1) Move phone/email off world-/peer-readable profiles into
--    profile_private (self-only RLS). Drop open profiles SELECT.
-- 2) Force balance = 0 on any client members INSERT.
-- ============================================================

-- ---------- A. profile_private for phone / email ----------

CREATE TABLE IF NOT EXISTS public.profile_private (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  phone text,
  email text,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.profile_private ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own profile_private" ON public.profile_private;
CREATE POLICY "Users manage own profile_private"
  ON public.profile_private
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_private TO authenticated;

-- Migrate existing PII (if columns still present on profiles)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'phone'
  ) THEN
    INSERT INTO public.profile_private (user_id, phone, email)
    SELECT id, phone, email
    FROM public.profiles
    WHERE (phone IS NOT NULL AND btrim(phone) <> '')
       OR (email IS NOT NULL AND btrim(email) <> '')
    ON CONFLICT (user_id) DO UPDATE
      SET phone = COALESCE(EXCLUDED.phone, public.profile_private.phone),
          email = COALESCE(EXCLUDED.email, public.profile_private.email),
          updated_at = now();
  END IF;
END $$;

-- ---------- B. Lock down profiles SELECT ----------

DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;

-- Own row (full non-PII profile row; phone/email live in profile_private)
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (id = auth.uid());

-- Contacts (display name / avatar for contact list)
DROP POLICY IF EXISTS "Users can read profiles of contacts" ON public.profiles;
CREATE POLICY "Users can read profiles of contacts"
  ON public.profiles FOR SELECT
  USING (
    id IN (SELECT contact_id FROM public.contacts WHERE contacts.user_id = auth.uid())
  );

-- Active members can see profiles of active/pending peers in shared groups
DROP POLICY IF EXISTS "Users can read profiles of group peers" ON public.profiles;
CREATE POLICY "Users can read profiles of group peers"
  ON public.profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.members them
      WHERE them.user_id = profiles.id
        AND them.status IN ('pending', 'active')
        AND public.is_group_member(them.group_id)
    )
  );

-- ---------- C. Drop phone/email columns from profiles ----------

ALTER TABLE public.profiles DROP COLUMN IF EXISTS phone;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS email;

-- ---------- D. DEFINER RPCs that previously read profiles.phone/email ----------

CREATE OR REPLACE FUNCTION public.get_meet_by_token(p_token text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    RETURN json_build_object('error', 'This meet link has already been used');
  END IF;

  SELECT p.display_name, p.profile_image_url, pp.phone, pp.email
    INTO v_name, v_profile_image_url, v_phone, v_email
  FROM public.profiles p
  LEFT JOIN public.profile_private pp ON pp.user_id = p.id
  WHERE p.id = v_meet.user_id;

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
$$;

-- ---------- E. members INSERT: cannot mint balance ----------

DROP POLICY IF EXISTS "Users can request to join groups" ON public.members;
CREATE POLICY "Users can request to join groups"
  ON public.members FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND balance = 0
    AND (
      status = 'pending'
      OR (
        status = 'active'
        AND EXISTS (
          SELECT 1 FROM public.groups
          WHERE id = members.group_id AND created_by = auth.uid()
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION public.members_force_zero_balance_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.balance := 0;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS members_force_zero_balance ON public.members;
CREATE TRIGGER members_force_zero_balance
  BEFORE INSERT ON public.members
  FOR EACH ROW
  EXECUTE FUNCTION public.members_force_zero_balance_on_insert();
