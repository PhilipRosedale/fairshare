# Removing a member by vote

Backend: `sql/removal-votes-schema.sql`. Client: `js/removal-votes.js`, hooked into the Members tab (`js/tabs.js`, `js/members.js`) and realtime (`js/realtime.js`).

## The rule

Nobody removes a member alone. It mirrors admission:

1. Any active member taps the `...` on another member's row and proposes removal, with an optional reason (280 chars, shown to the group). Proposing counts as a vote.
2. Every active member gets a push and sees the proposal at the top of the Members tab. Each can vote to remove, undo their vote, or (the proposer) withdraw. The person being voted on sees it but cannot vote.
3. The member is removed when votes reach the group's admission share, `$NEW_MEMBER_PERCENTAGE` (default 100%) of the eligible members (everyone active except the target). If the constitution sets `$VOTING_PERIOD_DAYS`, that is the window.
4. After the window ends, admissions count only those who voted. Removals do too, **but never below a simple majority of eligible members**, so a quiet group cannot lose someone to a single vote. If that is not reached the proposal expires.

Removal sets `members.status = 'removed'` (same as leaving), keeps the balance on the record, logs `member_removed` to `group_events`, and pushes the removed person directly (the group-events push does not reach them because they are no longer active).

## Server functions (all SECURITY DEFINER)

- `propose_removal(group_id, target_id, reason)`: checks both are active members, one open proposal per target, inserts the proposer's vote, logs `removal_proposed`. Returns the state.
- `vote_removal(id)` / `unvote_removal(id)`: for eligible members; proposers withdraw instead of unvoting.
- `withdraw_removal(id)`: proposer only; logs `removal_withdrawn`.
- `check_removal(id)`: computes votes/threshold and resolves the proposal (passed/expired) when due. Every read path calls it, so there is no cron.
- `list_removal_proposals(group_id)`: open proposals with counts and the caller's own state (`i_voted`, `i_proposed`, `is_me`).

Clients never write `removal_proposals` or `removal_votes` directly.

## Applying

Supabase SQL Editor, paste `sql/removal-votes-schema.sql`, Run. Idempotent. Takes effect for the web immediately after the deploy; native apps on their next build.
