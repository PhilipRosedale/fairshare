# App Store Connect — keywords, URLs, routing coverage

Use this when moving from TestFlight to the App Store. Paste values into **App Information** / **Version Information** as noted.

## Keywords (100 characters max)

Apple indexes the **app name** and **subtitle** separately; do not repeat them here. Trim or swap terms after you see Search Analytics in App Store Connect.

**Draft (95 characters):**

```text
contacts,QR,meet,trust,groups,chat,vouch,social,endorse,nearby,ledger,handshakes,invite,friends
```

## Support URL (required)

After you deploy the static site (e.g. GitHub Pages), set **Support URL** to:

`https://union42.net/support.html`

That page is public HTML with no sign-in. It explains how to get help and links to Terms and Privacy.

## Marketing URL (optional)

Set **Marketing URL** to:

`https://union42.net/marketing.html`

Use the same domain as the live app (`union42.net` per [app-store-review-notes.md](./app-store-review-notes.md)). If you later host a full marketing site elsewhere, replace this URL in App Store Connect only—no app update required.

## Routing App Coverage File

**Not required for Union today.** A Routing App Coverage File (GeoJSON) is only for apps that act as **routing apps** (turn-by-turn directions integrated with Apple’s routing ecosystem). The iOS target’s entitlements ([`ios/App/App/App.entitlements`](../ios/App/App/App.entitlements)) do not declare routing; the app is not a navigation product.

If you ever add that capability, you would need a coverage file describing supported regions and would upload it where App Store Connect / Xcode expects it for routing apps.
