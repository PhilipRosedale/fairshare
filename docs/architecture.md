# FairShare Architecture

FairShare is a static single-page application for creating and managing groups with their own digital currencies. It runs entirely on GitHub Pages with [Supabase](https://supabase.com) providing the backend.

**See also:** [fairshare-overview.md](fairshare-overview.md) — product summary (contacts, handshake, trust, groups).

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Hosting | GitHub Pages (static files) |
| Frontend | Vanilla HTML/CSS/JavaScript (multi-file: `fairshare/`) |
| Database | PostgreSQL via Supabase |
| Authentication | Supabase Auth (email + password) |
| API | Supabase auto-generated REST API (PostgREST) |
| Security | Row Level Security (RLS) policies on all tables |

## Key Design Decisions

### Multi-file application
The application is split into a thin HTML shell (`index.html`), a single CSS file (`styles.css`), and ~25 small JS modules in the `js/` directory. All JS files use plain global-scope functions (no import/export, no bundler) loaded via `<script>` tags in dependency order. This keeps deployment trivial (just push to GitHub), makes the application auditable by reading a single directory, and keeps each file small enough to review or edit in isolation.

### Client-side logic with server-side safety
Application logic runs in the browser using the Supabase JS SDK. Sensitive operations (currency transfers, endorsement checks, amendment resolution) use PostgreSQL functions (`SECURITY DEFINER`) that enforce business rules atomically on the server, regardless of what the client sends.

### Row Level Security everywhere
Every table has RLS enabled. Policies ensure users can only read/write data they're authorized to access. The anon API key is safe to expose in client-side code because RLS restricts all access.

### Future-proofing for self-custody
The `profiles` table includes a nullable `public_key` column. The current system uses email/password auth, but the schema is designed to eventually support a self-custodial model where users authenticate with a locally-stored private key.

## Database Schema

See [`fairshare-schema.sql`](../fairshare-schema.sql) for the full schema. Summary of tables:

| Table | Purpose |
|-------|---------|
| `profiles` | User display names and public keys (auto-created on signup) |
| `groups` | Group definitions: name, currency, fee rate, daily income, constitution |
| `members` | Many-to-many relationship between users and groups, with balance and status |
| `endorsements` | Tracking which members endorse which candidates |
| `transactions` | Currency transfer records |
| `votes` | Member votes on fee rate and daily income |
| `sponsorships` | Invite-only membership via unique token links |
| `amendments` | Proposed changes to group constitutions |
| `amendment_votes` | Member votes on amendments (approve/reject) |
| `group_events` | Activity log for realtime notifications (rate changes, membership, amendments) |

## Server-side Functions (RPCs)

| Function | Purpose |
|----------|---------|
| `send_currency` | Atomically transfer currency between members, applying fee |
| `check_endorsements` | Count endorsements and admit candidate if threshold met |
| `claim_sponsorship` | Validate invite token, create pending member, auto-endorse |
| `compute_tally` | Compute median of votes; auto-applies when enough members vote (per `$CHANGE_CURRENCY_RATES_PERCENTAGE`) |
| `distribute_daily_income` | Mint and distribute daily income to all active members |
| `resolve_amendment` | Count amendment votes, apply constitution changes if passed |
| `set_vote_delegation` / `withdraw_vote_delegation` | Delegate (or stop delegating) your vote on an `$ISSUE_TYPES` issue type; see `docs/constitution.md` |
| `get_sponsorship_by_token` | Public lookup of invite details (no auth required) |
| `log_group_event` | Client-side helper to insert events (e.g. `amendment_proposed`) |

## Realtime Notifications

The `group_events` table doubles as both a persistent activity log and a realtime notification channel. Supabase Realtime is enabled on this table, and the client subscribes to `INSERT` events filtered by `group_id`.

When a new event arrives, the client:
1. Prepends it to the visible "Activity" panel at the bottom of the group page
2. Shows a toast notification (for events triggered by other members)
3. Refreshes the relevant UI section (info bar for rate changes, members for joins, constitution for amendments)

Event types: `rate_change`, `member_joined`, `member_sponsored`, `amendment_proposed`, `amendment_passed`, `amendment_failed`.

Server-side `SECURITY DEFINER` functions insert events automatically. For client-initiated events (like proposing an amendment), the `log_group_event` RPC is called.

**Supabase setup**: Realtime replication must be enabled for the `group_events` table in Dashboard > Database > Replication.

## Membership Flow

```
Sponsor creates invite link
        │
        ▼
Candidate clicks link → Auth screen with sponsor info
        │
        ▼
Candidate signs up / logs in
        │
        ▼
claim_sponsorship() → Creates pending member + auto-endorsement
        │
        ▼
check_endorsements() → If threshold met, admit immediately
        │                  Otherwise, await more endorsements
        ▼
Active members endorse via Candidates panel
        │
        ▼
check_endorsements() → Admit when threshold reached
```

## Constitution System

See [constitution.md](constitution.md) for the full design.

## Files

| File | Description |
|------|-------------|
| `fairshare/index.html` | HTML shell (markup + `<script>` / `<link>` tags) |
| `fairshare/styles.css` | All CSS styles |
| `fairshare/js/` | Application JavaScript, one file per feature domain |
| `fairshare/sw.js` | Service worker (caching + push notifications) |
| `fairshare/manifest.json` | PWA manifest |
| `fairshare-schema.sql` | Complete PostgreSQL schema (tables, RLS, functions) |
| `docs/` | Design documentation |
