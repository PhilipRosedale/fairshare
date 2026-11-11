# fairshare-redirect

Sends every request on `app.fairshare.social` to the same path on `union42.net`,
so old invite links, `?meet=` links, password-reset emails and the privacy/terms
links baked into older app builds keep working.

GitHub Pages only allows one custom domain per site, so this has to be its own repo.

## Setup
1. Create a new public repo (e.g. `PhilipRosedale/fairshare-redirect`) with just the files in this folder.
2. Settings → Pages → deploy from `main` / root.
3. Custom domain: `app.fairshare.social`, then tick Enforce HTTPS once the cert is ready.
4. Do this only AFTER the main repo's custom domain has been switched to `union42.net`
   (Pages won't let two sites claim the same domain).

No DNS change is needed: `app.fairshare.social` should already point at GitHub Pages (it serves the app today).
