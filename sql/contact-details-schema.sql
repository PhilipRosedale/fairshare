-- Contact Details (Variation A) RPCs for Union
-- Run this in Supabase SQL Editor.
--
-- Adds two RPCs powering the redesigned Contact Details screen:
--   1. get_contact_trust_summary(p_contact_id) -- single-call trust card data + score
--   2. get_contact_history(p_contact_id, p_limit) -- unified "history together" timeline
--
-- Both are SECURITY DEFINER and gated on caller having the target as a contact.

-- =============================================================================
-- 0. Persisted per-contact trust score
-- =============================================================================
-- Cached so a future trigger / push can fire on changes. Always written from
-- the caller's perspective inside get_contact_trust_summary; readers should
-- treat get_contact_trust_summary as the source of truth.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS trust_score double precision NOT NULL DEFAULT 0;
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS trust_score_updated_at timestamptz;

-- =============================================================================
-- 0a. Per-user trust score component weights
-- =============================================================================
-- Each user can tune how much each of the three components (Direct, Mutuals,
-- Trusted) contributes to their trust scores. Defaults match the original
-- hard-coded weights (2 / 1 / 3). NULL is treated as default at read time so
-- existing rows behave unchanged. UI in the preferences screen writes to these
-- columns; get_contact_trust_summary reads them on every call.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS trust_weight_direct  double precision DEFAULT 2;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS trust_weight_mutuals double precision DEFAULT 1;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS trust_weight_trusted double precision DEFAULT 3;

-- =============================================================================
-- 1. get_contact_trust_summary
-- =============================================================================
-- Aggregates trust-card data into a single round trip:
--   * shared contacts / shared groups counts (informational stats)
--   * mutual_vouches / trusted_vouches / profile_picture_matches (informational)
--   * have_i_vouched = caller has any attestation -> this contact (any type)
--   * score = WEIGHTED, TIME-DECAYED 0..100 trust score for this contact, see
--     "WEIGHTED, TIME-DECAYED TRUST SCORE" block below for the full formula.
--   * combined_raw / max_combined_raw + per-component sums for transparency.
--
-- Side effect: every call recomputes combined_raw for ALL of the caller's
-- contacts and writes them to public.contacts.trust_score so a future trigger
-- can fire a "score changed" notification.

CREATE OR REPLACE FUNCTION public.get_contact_trust_summary(p_contact_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller_id uuid := auth.uid();

  -- ===== TIME-DECAY (HALF-LIFE = 2 YEARS) ===================================
  -- Every vouch contributes  exp(-c_decay_a * years_since_vouch)  to the sums
  -- below. With c_decay_a = ln(2) / c_half_life_years, a 2-year-old vouch is
  -- worth 0.5; a 4-year-old vouch is worth 0.25; a brand-new vouch is worth 1.
  c_half_life_years  CONSTANT double precision := 2.0;
  c_decay_a          CONSTANT double precision := ln(2.0) / 2.0;  -- = ln(2) / c_half_life_years
  c_seconds_per_year CONSTANT double precision := 31556952.0;     -- Julian year (365.2425d)

  -- ===== SCORE SCALE (HALF-POINT = 4.0) =====================================
  -- combined_raw maps onto 0..100 through a saturating curve:
  --   score = 100 * (1 - 2^(-combined_raw / c_score_half_raw))
  -- Each additional c_score_half_raw of combined_raw closes half the
  -- remaining distance to 100 -- the same halving convention as the time
  -- decay above, applied to vouch mass instead of age. With the default
  -- weights, two fresh direct vouches (combined_raw = 4) score 50, four
  -- score 75, and very strong ties approach 100 asymptotically.
  --
  -- The scale is ABSOLUTE: a contact's score depends only on vouches
  -- involving that contact, so it never shifts because an unrelated contact
  -- gained or lost vouches, and the same number means the same thing for
  -- every user. (The previous scheme divided by the caller's max, which
  -- pinned the top contact at 100 even with a single stale vouch and made
  -- every score move when any other contact's vouches changed.)
  c_score_half_raw   CONSTANT double precision := 4.0;

  -- ===== COMPONENT WEIGHTS ===================================================
  -- combined_raw = v_w_direct  * direct_sum
  --              + v_w_mutuals * mutuals_sum
  --              + v_w_trusted * trusted_sum
  -- Defaults are 2 / 1 / 3 but every caller can tune them in their profile;
  -- we read those values below so each user's trust scores reflect their own
  -- relative emphasis on the three signals.
  c_default_w_direct  CONSTANT double precision := 2.0;
  c_default_w_mutuals CONSTANT double precision := 1.0;
  c_default_w_trusted CONSTANT double precision := 3.0;
  v_w_direct  double precision := c_default_w_direct;
  v_w_mutuals double precision := c_default_w_mutuals;
  v_w_trusted double precision := c_default_w_trusted;

  v_shared_contacts int := 0;
  v_shared_groups int := 0;
  v_direct_count int := 0;
  v_mutual_vouches int := 0;
  v_trusted_vouches int := 0;
  v_profile_pic_matches int := 0;
  v_have_i_vouched boolean := false;
  v_shared_contacts_list json;
  v_shared_groups_list json;

  -- Oldest contributing vouch per component (used by the info dialog to
  -- display "X vouches over Y time" for each component).
  v_direct_oldest_at  timestamptz;
  v_mutuals_oldest_at timestamptz;
  v_trusted_oldest_at timestamptz;

  -- New trust-score numbers for the response.
  v_direct_sum       double precision := 0;
  v_mutuals_sum      double precision := 0;
  v_trusted_sum      double precision := 0;
  v_combined_raw     double precision := 0;
  v_max_combined_raw double precision := 0;
  v_score int := 0;
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
    RAISE EXCEPTION 'You can only view trust for your contacts';
  END IF;

  -- Caller's preferred weights (NULL columns or missing profile fall back to
  -- defaults). Negative values are clamped to zero so a misbehaving client
  -- can't flip the score's sign.
  SELECT
    GREATEST(COALESCE(p.trust_weight_direct,  c_default_w_direct),  0),
    GREATEST(COALESCE(p.trust_weight_mutuals, c_default_w_mutuals), 0),
    GREATEST(COALESCE(p.trust_weight_trusted, c_default_w_trusted), 0)
  INTO v_w_direct, v_w_mutuals, v_w_trusted
  FROM public.profiles p
  WHERE p.id = v_caller_id;

  -- ===========================================================================
  -- Informational stats (still surfaced in the trust-card readout below the
  -- ring). These are simple counts; they no longer feed the score directly.
  -- ===========================================================================

  -- Shared contacts (mutual contacts excluding the two parties).
  SELECT COUNT(DISTINCT c1.contact_id)
  INTO v_shared_contacts
  FROM public.contacts c1
  JOIN public.contacts c2
    ON c1.contact_id = c2.contact_id
  WHERE c1.user_id = v_caller_id
    AND c2.user_id = p_contact_id
    AND c1.contact_id NOT IN (v_caller_id, p_contact_id);

  -- Shared groups (both active members).
  SELECT COUNT(DISTINCT m1.group_id)
  INTO v_shared_groups
  FROM public.members m1
  JOIN public.members m2 ON m1.group_id = m2.group_id
  WHERE m1.user_id = v_caller_id
    AND m2.user_id = p_contact_id
    AND m1.status = 'active'
    AND m2.status = 'active';

  -- Shared contacts list (id, display_name, profile_image_url) for the
  -- "mutuals" preview/dialog. Capped to keep payload bounded; counts above
  -- remain authoritative for the stat.
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY lower(t.display_name)), '[]'::json)
  INTO v_shared_contacts_list
  FROM (
    SELECT p.id, p.display_name, p.profile_image_url
    FROM (
      SELECT DISTINCT c1.contact_id AS id
      FROM public.contacts c1
      JOIN public.contacts c2
        ON c1.contact_id = c2.contact_id
      WHERE c1.user_id = v_caller_id
        AND c2.user_id = p_contact_id
        AND c1.contact_id NOT IN (v_caller_id, p_contact_id)
      LIMIT 50
    ) m
    JOIN public.profiles p ON p.id = m.id
  ) t;

  -- Shared groups list (id, name, logo_url). Each is a group both parties
  -- are active members of, so the caller can navigate into it directly.
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY lower(t.name)), '[]'::json)
  INTO v_shared_groups_list
  FROM (
    SELECT g.id, g.name, g.logo_url
    FROM public.groups g
    WHERE g.id IN (
      SELECT m1.group_id
      FROM public.members m1
      JOIN public.members m2 ON m1.group_id = m2.group_id
      WHERE m1.user_id = v_caller_id
        AND m2.user_id = p_contact_id
        AND m1.status = 'active'
        AND m2.status = 'active'
      LIMIT 50
    )
  ) t;

  -- Direct Vouches: count + oldest. Caller's own attestations to contact.
  -- Informational; the time-decayed equivalent (direct_sum) feeds the score.
  SELECT COUNT(*), MIN(created_at)
  INTO v_direct_count, v_direct_oldest_at
  FROM public.attestations
  WHERE from_user_id = v_caller_id
    AND to_user_id   = p_contact_id;

  -- Mutual Vouches: count + oldest. Attestation rows authored by mutual
  -- contacts to either party. Informational only; the time-decayed
  -- equivalent (mutuals_sum) is what feeds the score.
  SELECT COUNT(*), MIN(a.created_at)
  INTO v_mutual_vouches, v_mutuals_oldest_at
  FROM public.attestations a
  WHERE a.to_user_id IN (v_caller_id, p_contact_id)
    AND a.from_user_id NOT IN (v_caller_id, p_contact_id)
    AND a.from_user_id IN (
      SELECT c1.contact_id
      FROM public.contacts c1
      JOIN public.contacts c2 ON c1.contact_id = c2.contact_id
      WHERE c1.user_id = v_caller_id
        AND c2.user_id = p_contact_id
    );

  -- Trusted Vouches: count + oldest. Attestation rows sent to the target by
  -- mutual contacts the caller has personally sent a 'trust' vouch to.
  -- Informational; the time-decayed equivalent (trusted_sum) feeds the score.
  SELECT COUNT(*), MIN(a.created_at)
  INTO v_trusted_vouches, v_trusted_oldest_at
  FROM public.attestations a
  WHERE a.to_user_id = p_contact_id
    AND a.from_user_id NOT IN (v_caller_id, p_contact_id)
    AND a.from_user_id IN (
      SELECT c1.contact_id
      FROM public.contacts c1
      JOIN public.contacts c2 ON c1.contact_id = c2.contact_id
      WHERE c1.user_id = v_caller_id
        AND c2.user_id = p_contact_id
        AND EXISTS (
          SELECT 1 FROM public.attestations t
          WHERE t.from_user_id = v_caller_id
            AND t.to_user_id   = c1.contact_id
            AND t.attestation_type = 'trust'
        )
    );

  -- Distinct people who confirmed the contact's profile picture.
  SELECT COUNT(DISTINCT from_user_id)
  INTO v_profile_pic_matches
  FROM public.attestations
  WHERE to_user_id = p_contact_id
    AND attestation_type = 'profile_picture_accurate';

  -- Have I vouched (any attestation type) for this contact?
  SELECT EXISTS (
    SELECT 1 FROM public.attestations
    WHERE from_user_id = v_caller_id AND to_user_id = p_contact_id
  ) INTO v_have_i_vouched;

  -- ===========================================================================
  -- WEIGHTED, TIME-DECAYED TRUST SCORE
  -- ---------------------------------------------------------------------------
  -- Three components, each a sum of  exp(-c_decay_a * years_since_vouch):
  --   DIRECT  = my vouches to this contact
  --   MUTUALS = vouches by mutual contacts (in both my and contact's lists,
  --             excluding both parties) sent to either of us
  --   TRUSTED = vouches by mutual contacts I have personally given a 'trust'
  --             attestation to, sent to this contact
  -- combined_raw = v_w_direct*DIRECT + v_w_mutuals*MUTUALS + v_w_trusted*TRUSTED
  --
  -- We recompute combined_raw for EVERY one of the caller's contacts on each
  -- call so the persisted contacts.trust_score column stays current for the
  -- contact-list ring and a future "score changed" trigger. The displayed
  -- score maps combined_raw onto an absolute 0..100 scale (see SCORE SCALE
  -- block above):
  --   round(100 * (1 - 2^(-combined_raw / c_score_half_raw)))
  -- ===========================================================================

  WITH
    my_contacts AS (
      SELECT contact_id FROM public.contacts WHERE user_id = v_caller_id
    ),
    -- For every x in my contacts, the set of mutual contacts (people who
    -- are contacts of both me and x, excluding me and x).
    mutuals AS (
      SELECT cx.contact_id  AS x_contact_id,
             cm.contact_id  AS mutual_id
      FROM public.contacts cx
      JOIN public.contacts cm  ON cm.user_id  = v_caller_id
      JOIN public.contacts cmx ON cmx.user_id = cx.contact_id
                              AND cmx.contact_id = cm.contact_id
      WHERE cx.user_id = v_caller_id
        AND cm.contact_id NOT IN (v_caller_id, cx.contact_id)
    ),
    -- People I have personally given an 'I trust you' attestation to.
    my_trust_set AS (
      SELECT DISTINCT to_user_id AS user_id
      FROM public.attestations
      WHERE from_user_id     = v_caller_id
        AND attestation_type = 'trust'
    ),
    direct_sums AS (
      SELECT mc.contact_id,
             COALESCE(SUM(EXP(-c_decay_a * (
               EXTRACT(EPOCH FROM (now() - a.created_at)) / c_seconds_per_year
             ))), 0)::double precision AS s
      FROM my_contacts mc
      LEFT JOIN public.attestations a
        ON a.from_user_id = v_caller_id
       AND a.to_user_id   = mc.contact_id
      GROUP BY mc.contact_id
    ),
    mutuals_sums AS (
      SELECT mc.contact_id,
             COALESCE(SUM(EXP(-c_decay_a * (
               EXTRACT(EPOCH FROM (now() - a.created_at)) / c_seconds_per_year
             ))), 0)::double precision AS s
      FROM my_contacts mc
      LEFT JOIN mutuals m            ON m.x_contact_id = mc.contact_id
      LEFT JOIN public.attestations a
        ON a.from_user_id = m.mutual_id
       AND a.to_user_id IN (v_caller_id, mc.contact_id)
      GROUP BY mc.contact_id
    ),
    trusted_sums AS (
      SELECT mc.contact_id,
             COALESCE(SUM(EXP(-c_decay_a * (
               EXTRACT(EPOCH FROM (now() - a.created_at)) / c_seconds_per_year
             ))), 0)::double precision AS s
      FROM my_contacts mc
      LEFT JOIN (
        SELECT m.x_contact_id, m.mutual_id
        FROM mutuals m
        JOIN my_trust_set t ON t.user_id = m.mutual_id
      ) tm ON tm.x_contact_id = mc.contact_id
      LEFT JOIN public.attestations a
        ON a.from_user_id = tm.mutual_id
       AND a.to_user_id   = mc.contact_id
      GROUP BY mc.contact_id
    ),
    combined AS (
      SELECT mc.contact_id,
             ( v_w_direct  * COALESCE(ds.s, 0)
             + v_w_mutuals * COALESCE(ms.s, 0)
             + v_w_trusted * COALESCE(ts.s, 0)
             )::double precision AS combined_raw
      FROM my_contacts mc
      LEFT JOIN direct_sums  ds ON ds.contact_id = mc.contact_id
      LEFT JOIN mutuals_sums ms ON ms.contact_id = mc.contact_id
      LEFT JOIN trusted_sums ts ON ts.contact_id = mc.contact_id
    )
  UPDATE public.contacts c
  SET trust_score            = combined.combined_raw,
      trust_score_updated_at = now()
  FROM combined
  WHERE c.user_id    = v_caller_id
    AND c.contact_id = combined.contact_id
    AND c.trust_score IS DISTINCT FROM combined.combined_raw;

  -- Per-component sums for THIS contact (returned for transparency / debug).
  SELECT COALESCE(SUM(EXP(-c_decay_a * (
           EXTRACT(EPOCH FROM (now() - created_at)) / c_seconds_per_year
         ))), 0)::double precision
  INTO v_direct_sum
  FROM public.attestations
  WHERE from_user_id = v_caller_id
    AND to_user_id   = p_contact_id;

  SELECT COALESCE(SUM(EXP(-c_decay_a * (
           EXTRACT(EPOCH FROM (now() - a.created_at)) / c_seconds_per_year
         ))), 0)::double precision
  INTO v_mutuals_sum
  FROM public.attestations a
  WHERE a.to_user_id IN (v_caller_id, p_contact_id)
    AND a.from_user_id NOT IN (v_caller_id, p_contact_id)
    AND a.from_user_id IN (
      SELECT c1.contact_id
      FROM public.contacts c1
      JOIN public.contacts c2 ON c1.contact_id = c2.contact_id
      WHERE c1.user_id = v_caller_id
        AND c2.user_id = p_contact_id
    );

  SELECT COALESCE(SUM(EXP(-c_decay_a * (
           EXTRACT(EPOCH FROM (now() - a.created_at)) / c_seconds_per_year
         ))), 0)::double precision
  INTO v_trusted_sum
  FROM public.attestations a
  WHERE a.to_user_id = p_contact_id
    AND a.from_user_id NOT IN (v_caller_id, p_contact_id)
    AND a.from_user_id IN (
      SELECT c1.contact_id
      FROM public.contacts c1
      JOIN public.contacts c2 ON c1.contact_id = c2.contact_id
      WHERE c1.user_id = v_caller_id
        AND c2.user_id = p_contact_id
        AND EXISTS (
          SELECT 1 FROM public.attestations t
          WHERE t.from_user_id     = v_caller_id
            AND t.to_user_id       = c1.contact_id
            AND t.attestation_type = 'trust'
        )
    );

  -- Read back combined_raw from the just-updated cache. max_combined_raw is
  -- still returned for transparency/debugging but no longer feeds the score.
  SELECT
    COALESCE(c.trust_score, 0),
    COALESCE((SELECT MAX(trust_score) FROM public.contacts WHERE user_id = v_caller_id), 0)
  INTO v_combined_raw, v_max_combined_raw
  FROM public.contacts c
  WHERE c.user_id = v_caller_id AND c.contact_id = p_contact_id;

  -- Absolute 0..100 scale; see SCORE SCALE block above. Depends only on this
  -- contact's combined_raw, so the number is stable and comparable.
  v_score := GREATEST(0, LEAST(100,
    ROUND(100.0 * (1.0 - POWER(2.0, -GREATEST(v_combined_raw, 0) / c_score_half_raw)))::int
  ));

  RETURN json_build_object(
    'score',                   v_score,
    'shared_contacts',         v_shared_contacts,
    'shared_groups',           v_shared_groups,
    'direct_count',            v_direct_count,
    'direct_oldest_at',        v_direct_oldest_at,
    'mutual_vouches',          v_mutual_vouches,
    'mutuals_oldest_at',       v_mutuals_oldest_at,
    'trusted_vouches',         v_trusted_vouches,
    'trusted_oldest_at',       v_trusted_oldest_at,
    'profile_picture_matches', v_profile_pic_matches,
    'have_i_vouched',          v_have_i_vouched,
    'shared_contacts_list',    v_shared_contacts_list,
    'shared_groups_list',      v_shared_groups_list,
    'direct_sum',              v_direct_sum,
    'mutuals_sum',             v_mutuals_sum,
    'trusted_sum',             v_trusted_sum,
    'combined_raw',            v_combined_raw,
    'max_combined_raw',        v_max_combined_raw,
    'w_direct',                v_w_direct,
    'w_mutuals',               v_w_mutuals,
    'w_trusted',               v_w_trusted
  );
END;
$$;


-- =============================================================================
-- 2. get_contact_history
-- =============================================================================
-- Returns up to p_limit recent shared events between caller and p_contact_id,
-- ordered most-recent-first. Event kinds:
--   nearby  -- contact_notifications row of type 'nearby_alert' between the two
--   selfie  -- contact_selfies row taken with the contact
--   vouch   -- attestation rows the caller gave TO p_contact_id (one direction
--              only -- vouches received from the contact are intentionally
--              never returned, see Privacy note below)
--   group   -- groups they both joined (event time = the LATER of the two joins)
--
-- Each row: { id text, kind text, text text, occurred_at timestamptz }.
-- Client formats `occurred_at` for display (formatLastSeen in utils).
--
-- Privacy: the integrity of the web of trust depends on a vouch recipient
-- never learning that a particular person vouched for them. We therefore
-- never expose individual rows where to_user_id = caller through any RPC --
-- only aggregate counts (see get_my_attestation_counts). This RPC enforces
-- that by filtering the vouch UNION arm to caller-as-attester only.

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
    -- Nearby alerts in either direction.
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

    -- Selfies the caller took with this contact.
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

    -- Vouches the caller GAVE to this contact. We deliberately do NOT
    -- include the reverse direction (vouches received from the contact):
    -- exposing those would let a vouch recipient learn who vouched for
    -- them, which breaks the privacy guarantee of the web of trust. Only
    -- aggregate counts of received vouches are ever returned to clients,
    -- via get_my_attestation_counts.
    SELECT
      ('v:' || a.id::text)         AS id,
      'vouch'::text                AS kind,
      ('You vouched (' || coalesce(at.description, a.attestation_type) || ')') AS text,
      a.created_at                 AS occurred_at
    FROM public.attestations a
    LEFT JOIN public.attestation_types at ON at.id = a.attestation_type
    WHERE a.from_user_id = v_caller_id
      AND a.to_user_id   = p_contact_id

    UNION ALL

    -- Shared groups: event time = LATER of the two join dates.
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
  )
  SELECT events.id, events.kind, events.text, events.occurred_at
  FROM events
  ORDER BY events.occurred_at DESC
  LIMIT GREATEST(COALESCE(p_limit, 6), 1);
END;
$$;
