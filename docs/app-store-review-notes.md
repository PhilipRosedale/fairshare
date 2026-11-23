# App Store Connect — App Review Notes

Paste the relevant sections of this document into the **App Review Information → Notes** field in App Store Connect when submitting Union to TestFlight or the App Store. This is intentionally exhaustive: explicit notes are the cheapest way to head off rejections.

---

## Demo account

Sign-up in Union normally requires a sponsor's QR code (the app uses an invite-only "web of trust" model). To let App Review test the app end to end **without scanning a QR code**, please use the demo account below:

- **Email / password:** entered in App Store Connect under **App Review Information → Sign-In Information**. Do not write them in this file: the repository is public.

This account is already a member of two demo groups so the reviewer can immediately exercise contacts, chat, group currencies, and location features.

> If you'd prefer the reviewer goes through the real sign-up flow instead, paste this one-time invite URL into Safari on the test device, then tap **Open in Union** when prompted:
> `https://union42.net/?invite=[fill in token]`

---

## What Union is

Union is a social app for building real-world trust. Members:

1. Meet in person and exchange contact info via QR codes ("the meet flow").
2. Vouch for each other.
3. Form groups and run a small **internal social-credit ledger** ("group credits") to coordinate community activity.
4. Vote on how their group runs (admitting and removing members, the group's rules), and optionally delegate their vote on a topic to another member.
5. Optionally share their live map location with selected contacts.

There is **no** real-money transfer, no purchasable digital good, and no cryptocurrency.

---

## Group "credits" / "currencies" — Guideline 3.1

Each group can define its own internal token (often called credits, coins, or points). These tokens:

- Are **fictional, in-app social tokens with no real-world or cash value**.
- **Cannot be purchased, redeemed, exchanged, withdrawn, or transferred outside the app.**
- Are **not** money, securities, cryptocurrency, or any regulated financial instrument.
- Exist only in our database, scoped to a single group.
- Are minted as a small "Daily Income" by each group on a schedule the group decides — purely a community game-mechanic.

There is **no** in-app purchase, no Stripe / PayPal / Apple Pay integration, no fiat on-ramp, no fiat off-ramp, no NFT/blockchain integration. Union does not require IAP because we never sell anything inside the app.

### In-person "Pay" and "Request"

Members can move group credits between each other in person by holding up a QR code: one person types an amount, the other scans it, and the credits move inside that group's ledger. The screens use the words **Pay** and **Request** and show a receipt-style summary, because that is the plainest way to describe who owes whom within the group's game. To be explicit:

- The "amount" is always the group's own fictional token (e.g. "12 pints" in a pub group), never a currency of any country.
- Nothing is charged to any card, bank, or Apple ID. There is no payment processor behind these screens.
- Credits never leave the group, cannot be withdrawn, and have no cash value, exactly as above.
- The QR code is just a one-time link into our own database (`?pay=TOKEN`); it is not a payment network QR.

To try it: sign in with the demo account on two devices (or one device plus the web app at https://union42.net), tap the centre button, choose **Request**, type an amount; on the other device tap the centre button, choose **Pay**, and point the camera at the first screen. The first screen updates on its own when the credits move.

(Schema labels like `payment_received` are internal event names.)

---

## User-generated content & safety — Guideline 1.2

Union has user-generated content (chat messages, profile photos, contact selfies, group logos, display names visible to other members). The app provides:

1. **Report objectionable content.** Every chat message from another user has a `⋮` button that opens a Report dialog. The contact details screen has an explicit "Report" button. Reports go into a `reports` table; we review them within 24 hours.
2. **Block users.** The contact details screen has a "Block" button. Blocking removes the user from the reporter's contacts, chat, nearby alerts, and map. A "Manage blocked users" screen in Profile lets users unblock later.
3. **Zero-tolerance policy.** The Terms of Use (linked in-app from Profile and at https://union42.net/terms.html) explicitly forbid objectionable content and abusive behavior, and state that violators are removed.
4. **Server-side enforcement.** Reports and blocks are enforced via Postgres RPCs (`report_content`, `block_user`, `unblock_user`) with row-level security — clients can only block / report as themselves.

---

## Account deletion — Guideline 5.1.1(v)

Users can delete their account from inside the app:

**Profile → Delete Account** → typed-confirmation dialog → calls the `delete_my_account()` RPC, which permanently deletes the auth user, profile, contacts, memberships, transactions, messages, photos, and location data.

Deletion is irreversible.

---

## Permissions & background modes

| Permission / mode | Why Union needs it | Where it's used in the app |
|---|---|---|
| Camera (`NSCameraUsageDescription`) | Scanning sponsor QR codes at sign-up; exchanging contacts on the "meet" screen; taking selfies with new contacts | Auth screen → Sign Up → Scan QR; bottom-bar 🤝 Meet button; contact handshake selfie |
| Photo Library (`NSPhotoLibraryUsageDescription`) | Picking a profile photo, group logo, or suggested-picture from the user's library | Profile screen → tap avatar; Group screen → tap group logo; Suggest-picture flow on contact details |
| Location When-In-Use (`NSLocationWhenInUseUsageDescription`) | Showing nearby Union members the user has explicitly chosen to be alerted about; reverse-geocoding for selfies on the Globe screen | Bottom-bar Globe; Contact details → "Notify if nearby" toggle |
| Location Always (`NSLocationAlwaysAndWhenInUseUsageDescription`) | Continuing live location share to a specific contact while the app is backgrounded — only after the user explicitly toggles "Share My Location" with a duration | Contact details → "Share My Location" toggle (For an Hour / Day / Week / Indefinitely) |
| `UIBackgroundModes` → `location` | Same as above — lets a single location fix complete when iOS wakes the app in the background for a significant location change, a visit, or a geofence exit while a share is active. Union does not run continuous GPS in the background | iOS only flips `allowsBackgroundLocationUpdates = true` when the user holds Always authorization AND has at least one active outbound share (see `BackgroundLocationPlugin.swift`) |
| `UIBackgroundModes` → `remote-notification` | APNs push for new chat messages, contact requests, and nearby alerts | Capacitor Push Notifications plugin |

### Background location demonstration

To exercise the background-location code path:

1. Sign in on the demo device.
2. Open any contact → toggle **"Share My Location"** → choose any duration.
3. Grant **Allow Always** (the system will prompt; you can also raise it later in Settings → Privacy → Location → Union → Always).
4. Lock the device and walk a short distance, or use Xcode's **Simulate Location** to move a few hundred meters.
5. Re-open the app on the second test device (or the web at https://union42.net) signed in as the contact you shared with — the pin updates each time the sharer moves roughly 150 m, arrives at or leaves a place, or opens Union.

When the user toggles **Share My Location** off, or the chosen duration expires, the app stops significant-change, visit, and geofence monitoring and sets `allowsBackgroundLocationUpdates = false`.

---

## Sign in with Apple — Guideline 4.8

Union offers three ways to sign in:

- **Sign in with Apple** (iOS app, and the website on Apple devices)
- **Continue with Google** (iOS app, Android app, website)
- **Email + password** (everywhere)

Because Google sign-in is offered, Sign in with Apple is offered alongside it as an equivalent option on the same screen. Sign in with Apple uses Apple's native sheet; we request only name and email, and "Hide My Email" addresses work normally. All three methods create the same kind of Union account (via Supabase Auth) and all can be deleted from **Profile → Delete Account**.

New members still need a sponsor's invite to join, whichever sign-in method they pick. The demo account uses email + password.

---

## New in 1.2

- **Vote delegation.** In a group's Members list, a member can delegate their vote on a topic (for example Membership or Monetary Policy) to another member, and withdraw it at any time. Delegations are private: only the person who set one can see it. It is a group-governance feature and has nothing to do with money.
- **Removing a member by vote.** Any member can propose removing someone from a group; the group votes and the proposal passes at the threshold the group set in its own rules. The person concerned sees the proposal. This is the group's own moderation tool and is separate from Report / Block, which are always available to every user.
- **"Continue from the web".** Someone who joined on the website and then installs the app can be signed in without typing their password again. The website copies a one-time sign-in link to the clipboard just before opening the App Store; on first launch the app reads the clipboard once to look for that link (iOS shows its standard paste prompt). If the user declines, or there is no link, the normal sign-in screen is shown and nothing else is read. The link works once and expires within an hour.
- **Shared locations in chat** now send a point inside the privacy circle the user chose, not the exact pin.
- Push notification reliability fixes.

---

## Privacy practices

- We do **not** use any third-party analytics or advertising SDKs.
- We do **not** share data with advertisers, data brokers, or trackers.
- We do **not** track users across other apps or websites.
- Sign in with Apple and Google sign-in are used only to authenticate the user; we receive a name and email address and nothing else from either provider.
- All transit is HTTPS / TLS via standard `URLSession` and the WebView; we do not implement custom cryptography (`ITSAppUsesNonExemptEncryption = false`).

The app's privacy policy is linked from inside the app (Profile → Privacy Policy) and at https://union42.net/privacy.html.

A Privacy Manifest (`PrivacyInfo.xcprivacy`) is included in the bundle. It declares:

- `NSPrivacyTracking = false`
- Data categories collected: email, photos, location, user content (messages), display name, push token
- Required-Reason API: `UserDefaults` (CA92.1 — used by the background-location plugin to persist Supabase config across app launches so location keeps uploading after a relaunch).

---

## Age rating

We have answered the App Store Connect age rating questionnaire conservatively. Under Apple's current age-rating system (4+, 9+, 13+, 16+, 18+ — the old 17+ band no longer exists), Union is rated **18+** via **Override to Higher Age Rating** because:

- Chat is unmoderated user-generated text.
- Users can meet new people via QR-code handshakes.
- Users can share live location with contacts.
- Our sign-up flow and Terms of Use require users to confirm they are **18 or older**. (Apple requires an override when a EULA's minimum age exceeds the calculated rating.)

After completing the content/capability questions (including the messaging / user-generated content capability), we select **Override to Higher Age Rating → 18+** rather than "Not Applicable". The sign-up gate, Terms of Use, and Privacy Policy all consistently state an 18+ minimum age.

---

## Reviewer FAQ

- **Q: Can I sign up without a sponsor?** Use the demo account above, or paste the one-time invite link into Safari on the device.
- **Q: How do I trigger a chat message?** Open one of the demo groups → **Chat** tab → type a message. To test the report flow, use the second demo account on a separate device (or web) to send a message, then tap the `⋮` next to it.
- **Q: How do I test "Block"?** Open a contact → scroll to the **Safety** card → tap **Block**. Confirm. The contact disappears from the contacts list, chat, and map.
- **Q: How do I delete my account?** Profile → **Delete Account** → type `DELETE` → tap **Delete my account**.
