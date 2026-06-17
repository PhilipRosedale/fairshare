# Push notifications

Canonical list of every remote push notification the FairShare app sends. Keep
this file in sync whenever push-related code changes — the
[push-notifications-doc Cursor rule](../.cursor/rules/push-notifications-doc.mdc)
will remind the agent.

For each push we record: **trigger**, **recipient**, **title**, **body**,
**tap-target URL**, and the **defining file + line range**.

---

## Delivery infrastructure

All pushes flow through the same plumbing.

- **Routing layer (SQL):** `send_push_to_group(group_id, actor_id, title, body, url)`
  and `send_push_to_users(user_ids[], actor_id, title, body, url)` in
  [sql/fairshare-schema.sql](../sql/fairshare-schema.sql) (1654–1857). The
  `actor_id` is excluded from the recipient set so the actor doesn't push
  themselves.
- **Web Push channel:** [supabase/functions/send-push/index.ts](../supabase/functions/send-push/index.ts)
  — fans out to `push_subscriptions` rows via the `web-push` library.
- **Native app channel:** [supabase/functions/send-push-apns/index.ts](../supabase/functions/send-push-apns/index.ts)
  — fans out to `device_push_tokens`, routing iOS tokens through APNs HTTP/2
  and Android tokens through Firebase Cloud Messaging HTTP v1. Only active if
  [sql/apns-push-schema.sql](../sql/apns-push-schema.sql) has been applied (it
  overrides `send_push_to_group` / `send_push_to_users` to also POST to the
  native-device Edge Function).
- **Opt-in:** All pushes are gated by `profiles.push_notifications` for the
  recipient (NULL is treated as enabled).
- **Tap routing:** Deep links are handled by `handleNotificationNavigation` in
  [js/push.js](../js/push.js). Service-worker fallback for Web Push
  is in [sw.js](../sw.js) (71–103).

---

## 1. Group activity (catch-all)

Every row inserted into `group_events` fans out a push to every active group
member except the actor. This single firehose covers most group-related
notifications (payments added/edited/deleted, members joining or being added,
membership amendments, rate changes, etc.).

| Field | Value |
|-------|-------|
| Trigger | `INSERT` on `public.group_events` (`on_group_event_push` trigger) |
| Recipient | Active group members with push enabled, excluding the actor |
| Title | `{group name}` (or `"Union"` if the group has no name) |
| Body | `NEW.summary` from the event row |
| URL | `/?group={groupUuid}` |
| Source | [sql/fairshare-schema.sql](../sql/fairshare-schema.sql) 1720–1739 |

---

## 2. Group chat messages

Separate trigger on `chat_messages` so the title/body are chat-shaped.

| Field | Value |
|-------|-------|
| Trigger | `INSERT` on `public.chat_messages` (`on_chat_message_push` trigger) |
| Recipient | Group members with push enabled, excluding the message author |
| Title | `"{group name} Chat"` |
| Body | `"{sender} sent a photo"` for image messages (`📷image:`), `"{sender} shared a location"` for location (`📍location:`), otherwise `"{sender}: {first 80 chars}…"` |
| URL | `/?group={groupUuid}&tab=chat` |
| Source | [sql/fairshare-schema.sql](../sql/fairshare-schema.sql) 2059–2090 |

---

## 2a. Direct messages (contact chat)

One-to-one contact chat uses a dedicated trigger on `direct_messages`.

| Field | Value |
|-------|-------|
| Trigger | `INSERT` on `public.direct_messages` (`on_direct_message_push` trigger) |
| Recipient | The message recipient (`to_user_id`) if push is enabled |
| Title | `"Union"` |
| Body | `"{sender} sent a photo"` for image messages (`📷image:`), `"{sender} shared a location"` for location (`📍location:`), otherwise `"{sender}: {first 80 chars}…"` |
| URL | `/?action=view_dm&contact={senderUuid}` |
| Source | [sql/direct-messages-schema.sql](../sql/direct-messages-schema.sql) 139–174 |

---

## 3. Group membership offer (invitation)

When someone sponsors you into a group via the `offer_group_membership` RPC.

| Field | Value |
|-------|-------|
| Trigger | RPC `offer_group_membership(p_group_id, p_candidate_id)` after insert into `group_invitations` |
| Recipient | The candidate (`p_candidate_id`) |
| Title | `"Group Membership Offer"` |
| Body | `"{sponsor name} has offered to sponsor your membership in {group name}"` |
| URL | `/` |
| Source | [sql/group-invitations-schema.sql](../sql/group-invitations-schema.sql) 81–92 |

---

## 4. Handshake completed — new contact

Sent to the QR/meet issuer when another user completes the handshake. The
current `complete_meet(p_token, p_meet_source)` records how the pair met
(`met_via`) and pushes the issuer.

| Field | Value |
|-------|-------|
| Trigger | RPC `complete_meet(p_token, p_meet_source)` after pairing (`p_meet_source` defaults to `URL`; in-app QR scans use `F2F`) |
| Recipient | The meet issuer (`v_meet_request.user_id`) |
| Title | `"Union"` |
| Body | `"{name} just joined Union via your handshake."` if the newcomer signed up via that token, otherwise `"{name} is now your contact."` |
| URL | `/?action=view_contact&contact={newContactUuid}` |
| Source | `complete_meet(p_token, p_meet_source)` — current definition in [sql/meet-token-reserve-at-signup.sql](../sql/meet-token-reserve-at-signup.sql); `p_meet_source` / `contacts.met_via` introduced in [sql/contact-intro-and-met-via-migration.sql](../sql/contact-intro-and-met-via-migration.sql) |

Also writes a `contact_notifications` row of type `new_contact` for in-app
display.

---

## 5. New contact selfie

When a contact saves a selfie of the two of you via `add_contact_selfie`.

| Field | Value |
|-------|-------|
| Trigger | RPC `add_contact_selfie(...)` after mirrored selfie rows are inserted |
| Recipient | The other party (`p_contact_id`) |
| Title | `"Union"` |
| Body | `"{name} took a new selfie with you."` |
| URL | `/?action=view_contact&contact={callerUuid}` |
| Source | [sql/contact-list-schema.sql](../sql/contact-list-schema.sql) 147–155 |

---

## 5a. Contact intro (introduce two contacts)

When someone sends an intro from Contact Details, each recipient gets a push.
Tap opens the intro dialog (`handleNotificationNavigation` in
[js/push.js](../js/push.js); in-app Realtime in [js/auth.js](../js/auth.js)).

| Field | Value |
|-------|-------|
| Trigger | RPC `send_contact_intro(p_contact_a, p_contact_b, p_message)` |
| Recipient | Each of the two parties (`p_contact_a`, `p_contact_b`), excluding the actor |
| Title | `"Union"` |
| Body | `"{introducer} wants you to meet {other}"` — `other` is the opposite party for that recipient |
| URL | `/?action=contact_intro&intro={introUuid}` |
| Source | [sql/contact-intro-and-met-via-migration.sql](../sql/contact-intro-and-met-via-migration.sql) `send_contact_intro` |

Also inserts `contact_notifications` rows of type `contact_intro` with `data.intro_id`, `data.other_user_id`, and `data.intro_text`.

---

## 6. Contact updated their profile picture

Fanned out to every user who has the actor in their `contacts` list.

| Field | Value |
|-------|-------|
| Trigger | RPC `notify_contacts_of_profile_picture_change(p_actor_id)`; called from [js/modals.js](../js/modals.js) after a successful upload |
| Recipient | All users whose `contacts` includes `p_actor_id`, excluding the actor |
| Title | `"Union"` |
| Body | `"{name} updated their profile picture"` |
| URL | `/?action=view_contact&contact={actorUuid}` |
| Source | [sql/fairshare-schema.sql](../sql/fairshare-schema.sql) 1864–1904 |

In-app: writes `contact_notifications` rows of type `profile_picture_updated`.

---

## 6a. Contact changed their display name

When the user saves a new display name in preferences (`savePreferences` in
[js/modals.js](../js/modals.js)).

| Field | Value |
|-------|-------|
| Trigger | RPC `notify_contacts_of_display_name_change(p_actor_id, p_old_display_name, p_new_display_name)`; called from [js/modals.js](../js/modals.js) after a successful profile update when the trimmed name changed |
| Recipient | All users whose `contacts` includes `p_actor_id`, excluding the actor |
| Title | `"Union"` |
| Body | `"{old} changed their name to {new}"` — empty/whitespace-only old or new side falls back to `"Someone"` |
| URL | `/?action=view_contact&contact={actorUuid}` |
| Source | [sql/fairshare-schema.sql](../sql/fairshare-schema.sql) 1948–1998; constraint + one-shot deploy [sql/display-name-change-push-schema.sql](../sql/display-name-change-push-schema.sql) |

In-app: writes `contact_notifications` rows of type `display_name_changed` (with `data.old_display_name` / `data.new_display_name`). Realtime handling updates the contact list and open Contact Details hero in [js/auth.js](../js/auth.js) / [js/contacts.js](../js/contacts.js) / [js/contact-details.js](../js/contact-details.js).

---

## 6b. Contact updated their email or phone (profile)

When the user saves a new email and/or phone on their profile (preferences or
the sponsor share dialog), every user who lists them as a contact is notified.

| Field | Value |
|-------|-------|
| Trigger | RPC `notify_contacts_of_profile_update(p_actor_id, p_message)`; called from [js/modals.js](../js/modals.js) (`persistProfileEmailPhone`, `savePreferences`) |
| Recipient | All users whose `contacts` includes `p_actor_id`, excluding the actor |
| Title | `"Union"` |
| Body | `p_message` (e.g. `"{name} updated their email."`) |
| URL | `/?action=view_contact&contact={actorUuid}` |
| Source | [sql/fairshare-schema.sql](../sql/fairshare-schema.sql) 1909–1945 |

In-app: writes `contact_notifications` rows of type `profile_updated`.

---

## 6c. Contact first shared or changed email/phone with you

When someone saves outbound `contact_shared` data for one contact and the phone
or email values newly apply or change (not merely turning sharing off), that
contact gets a push. First-time sharing still inserts `contact_shares` for
Realtime toasts while foregrounded.

| Field | Value |
|-------|-------|
| Trigger | `saveOutboundProfileShareForContact` / `saveShareWithContact` in [js/contacts.js](../js/contacts.js) and `submitSponsorShareInfoDialog` in [js/modals.js](../js/modals.js) call `sendInboundShareEmailPhonePush` ([js/utils.js](../js/utils.js)) |
| Recipient | The `contact_id` / sponsor receiving the share |
| Title | `APP_NAME` (`"Union"`) |
| Body | Built by `buildInboundShareEmailPhonePushBody` — e.g. `"{name} shared their email with you."`, `"{name} updated the phone number they share with you."`, or combined first/update phrases |
| URL | `/?action=view_contact&contact={sharerUuid}` |
| Source | [js/utils.js](../js/utils.js) `buildInboundShareEmailPhonePushBody`, `sendInboundShareEmailPhonePush` |

---

## 7. Contact suggested a profile picture for you

When a contact uses "Suggest profile picture" via `suggest_profile_picture`.

| Field | Value |
|-------|-------|
| Trigger | RPC `suggest_profile_picture(p_actor_id, p_contact_id, p_image_url)` |
| Recipient | The suggested contact (`p_contact_id`) |
| Title | `"Union"` |
| Body | `"{name} suggests this new profile picture"` |
| URL | `/?action=suggested_picture` |
| Source | [sql/fairshare-schema.sql](../sql/fairshare-schema.sql) 2039–2069 |

---

## 8. "Met on" date set

When a contact records the date you two met via `set_first_met_date`.

| Field | Value |
|-------|-------|
| Trigger | RPC `set_first_met_date(p_contact_id, p_met_date)` when `p_met_date` is non-null |
| Recipient | The contact (`p_contact_id`) |
| Title | `"Union"` |
| Body | `"{name} says you met on {formatted date}"` |
| URL | `/` (no deep link wired — could route to the contact view) |
| Source | [sql/fairshare-schema.sql](../sql/fairshare-schema.sql) 1952–2002 |

In-app: writes `contact_notifications` rows of type `met_date_set` with
`data.met_date`.

---

## 9. Contact is nearby

When you and a mutual `notify_nearby` contact are within ~1 mile, **both**
parties get a push. Cooldown ≥ 1 hour per pair; the contact's location must be
fresh (≤ 10 minutes old).

| Field | Value |
|-------|-------|
| Trigger | RPC `update_location_and_check_nearby(...)` discovers a mutual nearby pair |
| Recipient | Both users — two pushes are sent, each with the other party as actor |
| Title | `"Union"` |
| Body | `"{other name} is nearby!"` |
| URL | `/` (no deep link wired) |
| Source | [sql/nearby-schema.sql](../sql/nearby-schema.sql) 124–197; client poller in [js/nearby.js](../js/nearby.js) |

Note: [js/nearby.js](../js/nearby.js) only calls the RPC while
`document.visibilityState === 'visible'`, so detection runs when the user has
the app foregrounded; recipients can still be backgrounded.

---

## 10. Location share started

Sent from the client when a user enables "Share my location" with a specific
contact.

| Field | Value |
|-------|-------|
| Trigger | `shareLocationWithContact` in [js/location-sharing.js](../js/location-sharing.js) calls `db.rpc('send_push_to_users', ...)` |
| Recipient | The chosen contact |
| Title | `APP_NAME` (`"Union"`) |
| Body | `"{your display name} started sharing location with you"` |
| URL | `/` |
| Source | [js/location-sharing.js](../js/location-sharing.js) `shareLocationWithContact` |

In-app: also inserts a `contact_notifications` row of type
`location_share_started`.

---

## 11. Shared vouch received

When a contact sends a vouch whose type is marked `shared` in `attestation_types`
(e.g. Accurate Profile Picture, I Love You).

| Field | Value |
|-------|-------|
| Trigger | RPC `create_attestation(p_to_user_id, p_attestation_type)` after insert, when the type's `shared` flag is true |
| Recipient | The vouched contact (`p_to_user_id`) |
| Title | `"Union"` |
| Body | `"{attester display name} says {vouch description}"` |
| URL | `/?action=view_contact&contact={attesterUuid}` |
| Source | [sql/vouch-types-migration.sql](../sql/vouch-types-migration.sql) `create_attestation` |

Non-shared vouch types do not notify the recipient (older clients still call the
same RPC; behavior is determined server-side by the catalog).

---

## Maintenance

When you add, remove, or change a push notification, update this file in the
same change. The Cursor rule
[.cursor/rules/push-notifications-doc.mdc](../.cursor/rules/push-notifications-doc.mdc)
flags the most common entry points (`send_push_to_*` calls in SQL, the push
edge functions, and the relevant `js/` modules).
