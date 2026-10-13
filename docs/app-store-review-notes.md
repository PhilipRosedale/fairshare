# App Store Connect — App Review Notes

Paste the relevant sections of this document into the **App Review Information → Notes** field in App Store Connect when submitting Union to TestFlight or the App Store. This is intentionally exhaustive: explicit notes are the cheapest way to head off rejections.

---

## Demo account

Sign-up in Union normally requires a sponsor's QR code (the app uses an invite-only "web of trust" model). To let App Review test the app end to end **without scanning a QR code**, please use the demo account below:

- **Email:** _[fill in before submission]_
- **Password:** _[fill in before submission]_

This account is already a member of two demo groups so the reviewer can immediately exercise contacts, chat, group currencies, and location features.

> If you'd prefer the reviewer goes through the real sign-up flow instead, paste this one-time invite URL into Safari on the test device, then tap **Open in Union** when prompted:
> `https://app.fairshare.social/?invite=[fill in token]`

---

## What Union is

Union is a social app for building real-world trust. Members:

1. Meet in person and exchange contact info via QR codes ("the meet flow").
2. Vouch for each other.
3. Form groups and run a small **internal social-credit ledger** ("group credits") to coordinate community activity.
4. Optionally share their live map location with selected contacts.

There is **no** real-money transfer, no purchasable digital good, and no cryptocurrency.

---

## Quick Start

1. **Sign In.** Sign-up normally requires an in-person QR handshake with an existing member. To test without that, sign in with a demo account.

2. **Meet Handshake.** Tap the heart-shaped `Meet` button in the bottom bar. You'll see your own QR code plus a live camera view labeled **"Scan QR Code."** This is designed for two people to hold their phones facing each other so each camera scans the other's code. To test solo: tap "Copy invite link" instead of scanning, then open that link in a private/incognito browser tab (signed out) and sign up as a new user there. This completes the same handshake without needing a second device. Screenshots of this flow: https://app.fairshare.social/support.html#app-review

3. **Contacts.** After connecting via Meet or the demo account's existing contacts, open a contact to see profile info, vouching, and an optional selfie ("Selfies together"). Click on their profile picture to "Suggest a new picture." 

4. **Groups.** From the Groups tab, open one of the demo account's groups to see chat, the internal credit balance, and voting on the fee rate / daily income. These credits are fictional and cannot be bought, sold, or withdrawn.

Camera permission is used for scanning a sponsor's QR code at sign-up, the Meet handshake above, taking a selfie with a contact, and suggesting a new profile picture for a contact.

Full guideline-by-guideline detail, background-location testing steps, and a reviewer FAQ follow below.

---

## Group "credits" / "currencies" — Guideline 3.1

Each group can define its own internal token (often called credits, coins, or points). These tokens:

- Are **fictional, in-app social tokens with no real-world or cash value**.
- **Cannot be purchased, redeemed, exchanged, withdrawn, or transferred outside the app.**
- Are **not** money, securities, cryptocurrency, or any regulated financial instrument.
- Exist only in our database, scoped to a single group.
- Are minted as a small "Daily Income" by each group on a schedule the group decides — purely a community game-mechanic.

There is **no** in-app purchase, no Stripe / PayPal / Apple Pay integration, no fiat on-ramp, no fiat off-ramp, no NFT/blockchain integration. Union does not require IAP because we never sell anything inside the app.

(Schema labels like `payment_received` are internal event names; the user-facing UI exclusively uses words like "credits" and "send" — no real-money payment language.)

---

## User-generated content & safety — Guideline 1.2

Union has user-generated content (chat messages, profile photos, contact selfies, group logos, display names visible to other members). The app provides:

1. **Report objectionable content.** Every chat message from another user has a `⋮` button that opens a Report dialog. The contact details screen has an explicit "Report" button. Reports go into a `reports` table; we review them within 24 hours.
2. **Block users.** The contact details screen has a "Block" button. Blocking removes the user from the reporter's contacts, chat, nearby alerts, and map. A "Manage blocked users" screen in Profile lets users unblock later.
3. **Zero-tolerance policy.** The Terms of Use (linked in-app from Profile and at https://app.fairshare.social/terms.html) explicitly forbid objectionable content and abusive behavior, and state that violators are removed.
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
| Camera (`NSCameraUsageDescription`) | Scanning sponsor QR codes at sign-up; exchanging contacts on the "meet" screen; taking selfies with new contacts; suggesting a new profile picture for a contact | Auth screen → Sign Up → Scan QR; bottom-bar 🤝 Meet button; contact handshake selfie; Contact Details → Suggest new picture → Take a picture|
| Photo Library (`NSPhotoLibraryUsageDescription`) | Picking a profile photo, group logo, or suggested-picture from the user's library | Profile screen → tap avatar; Group screen → tap group logo; Suggest-picture flow on contact details |
| Location When-In-Use (`NSLocationWhenInUseUsageDescription`) | Showing nearby Union members the user has explicitly chosen to be alerted about; reverse-geocoding for selfies on the Globe screen | Bottom-bar Globe; Contact details → "Notify if nearby" toggle |
| Location Always (`NSLocationAlwaysAndWhenInUseUsageDescription`) | Continuing live location share to a specific contact while the app is backgrounded — only after the user explicitly toggles "Share My Location" with a duration | Contact details → "Share My Location" toggle (For an Hour / Day / Week / Indefinitely) |
| `UIBackgroundModes` → `location` | Same as above — required so the location share keeps streaming when the user puts the phone away | iOS only flips `allowsBackgroundLocationUpdates = true` when the user holds Always authorization AND has at least one active outbound share (see `BackgroundLocationPlugin.swift`) |
| `UIBackgroundModes` → `remote-notification` | APNs push for new chat messages, contact requests, and nearby alerts | Capacitor Push Notifications plugin |

### Camera permission — recovering from a denial

If a user taps **Don't Allow** on the camera permission prompt, iOS never re-prompts — the only way back is Settings → Union → Camera. Requiring that manual step is standard iOS behavior and not itself a review risk, but the app previously gave no indication that Settings was the way back at all (just a dead-end "Could not access camera" toast). Both camera entry points ([js/auth.js](../js/auth.js) QR scan, [js/contacts.js](../js/contacts.js) selfie/meet overlay) now detect a permission-denial error (`NotAllowedError`) specifically and show a tappable toast — "Camera access is off. Tap here to open Settings and allow it for Union." — that deep-links to this app's page in iOS Settings (`app-settings:`) via `openIOSAppSettings()` in [js/utils.js](../js/utils.js). Other camera errors (e.g. no camera hardware) still show the original generic message, since Settings can't help there. This is a UX improvement, not a documented fix for a specific rejection.

### Testing the Meet handshake with a single device — Guideline 2.1

The **Meet** flow (bottom-bar 🤝 button) is designed for two people scanning each other's QR code with their own camera, which a solo reviewer with one device cannot do. Do **not** rely on the camera-to-camera path for review. Instead:

1. Sign in as the demo account → tap the 🤝 **Meet** button.
2. Tap **Copy Link** (skip the camera scan entirely).
3. Open a **new private/incognito Safari tab**, signed out, and paste the copied link (`https://app.fairshare.social/?meet=TOKEN`).
4. Sign up as a new user from that tab. This completes the handshake and adds both accounts as contacts of each other — the same underlying `complete_meet` RPC that the camera-to-camera scan uses.

Note: opening a Meet link while **already signed in** intentionally does nothing but show a toast ("Share this link with someone who is not yet on Union") — the link only completes a connection during a fresh sign-up, so testing requires the private-tab-and-sign-up path above, not a second logged-in demo account.

### Background location demonstration

To exercise the background-location code path:

1. Sign in on the demo device.
2. Open any contact → toggle **"Share My Location"** → choose any duration.
3. Grant **Allow Always** (the system will prompt; you can also raise it later in Settings → Privacy → Location → Union → Always).
4. Lock the device and walk a short distance, or use Xcode's **Simulate Location** to move a few hundred meters.
5. Re-open the app on the second test device (or the web at https://app.fairshare.social) signed in as the contact you shared with — the moving pin updates in near-real-time.

When the user toggles **Share My Location** off, or the chosen duration expires, the app immediately stops calling `startUpdatingLocation` and sets `allowsBackgroundLocationUpdates = false`.

---

## Sign in with Apple — Guideline 4.8

Union uses **email + password authentication only** (via Supabase Auth). It does **not** offer Google / Facebook / Apple SSO. Per Guideline 4.8, Sign in with Apple is required only when third-party SSO providers are offered, so it is not required here. We may add it in a future release.

---

## Privacy practices

- We do **not** use any third-party analytics or advertising SDKs.
- We do **not** share data with advertisers, data brokers, or trackers.
- We do **not** track users across other apps or websites.
- All transit is HTTPS / TLS via standard `URLSession` and the WebView; we do not implement custom cryptography (`ITSAppUsesNonExemptEncryption = false`).

The app's privacy policy is linked from inside the app (Profile → Privacy Policy) and at https://app.fairshare.social/privacy.html.

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
- **Q: How do I test the Meet/handshake flow with only one device?** See "Testing the Meet handshake with a single device" above — tap **Copy Link** in the Meet screen instead of scanning, then open the link in a private Safari tab and sign up as a new user there.
- **Q: How do I trigger a chat message?** Open one of the demo groups → **Chat** tab → type a message. To test the report flow, use the second demo account on a separate device (or web) to send a message, then tap the `⋮` next to it.
- **Q: How do I test "Block"?** Open a contact → scroll to the **Safety** card → tap **Block**. Confirm. The contact disappears from the contacts list, chat, and map.
- **Q: How do I delete my account?** Profile → **Delete Account** → type `DELETE` → tap **Delete my account**.
