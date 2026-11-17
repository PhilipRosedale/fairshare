# Removing a member by vote

Backend: `sql/removal-votes-schema.sql`. Client: `js/removal-votes.js`, hooked into the Members tab (`js/tabs.js`, `js/members.js`) and realtime (`js/realtime.js`).

## The rule

It mirrors admission, delegation included:

1. Any active member taps another member in the Members tab and chooses **Propose removal from group** on their sheet, with an optional reason (280 chars, shown to the group). Proposing counts as a vote.
2. Every active member gets a push and sees the proposal at the top of the Members tab. Each can vote to remove, undo their vote, or (the proposer) withdraw. The person being voted on sees it but cannot vote.
3. Votes are counted the way endorsements are: each voter carries their own vote plus every vote delegated to them on the **Membership** issue type, following chains (see [Vote Delegation](constitution.md#vote-delegation-liquid-democracy)). The person being voted on never counts, either directly or as a link in someone else's chain.
4. The member is removed **immediately** when the counted votes reach the group's admission share, `$NEW_MEMBER_PERCENTAGE` (default 100%) of the eligible votes (everyone active except the target). A delegate holding enough Membership votes therefore removes someone alone, on proposing. If the constitution sets `$VOTING_PERIOD_DAYS`, that is the window.
5. Making, changing or withdrawing a Membership delegation re-counts open removal votes straight away (trigger on `vote_delegations`), so a removal can also pass or fall back below the line when voting power moves.
6. After the window ends, admissions count only the votes cast. Removals do too, **but never below a simple majority of eligible votes**, so a quiet group cannot lose someone to a single vote. If that is not reached the proposal expires.
7. If the person leaves on their own while the vote is open, the proposal expires.

Removal sets `members.status = 'removed'` (same as leaving), keeps the balance on the record, logs `member_removed` to `group_events`, and pushes the removed person directly (the group-events push does not reach them because they are no longer active).

## Server functions (all SECURITY DEFINER)

- `propose_removal(group_id, target_id, reason)`: checks both are active members, one open proposal per target, inserts the proposer's vote, logs `removal_proposed`. Returns the state.
- `vote_removal(id)` / `unvote_removal(id)`: for eligible members; proposers withdraw instead of unvoting.
- `withdraw_removal(id)`: proposer only; logs `removal_withdrawn`.
- `check_removal(id)`: computes delegated votes and threshold and resolves the proposal (passed/expired) when due. Every read path calls it, so there is no cron. Not callable by clients.
- `removal_vote_weights(group_id, issue_type, voters, target_id)`: the delegation walk, with the target left out. Internal.
- `list_removal_proposals(group_id)`: open proposals with counts and the caller's own state (`i_voted`, `i_proposed`, `is_me`).

Clients never write `removal_proposals` or `removal_votes` directly.

## Applying

Apply `sql/vote-delegation-schema.sql` first (it defines `vote_delegations` and `resolve_issue_type`). Then Supabase SQL Editor, paste `sql/removal-votes-schema.sql`, Run. Idempotent. Takes effect for the web immediately after the deploy; native apps on their next build.
