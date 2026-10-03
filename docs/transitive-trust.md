# Transitive Trust: Propagation, Discovery, and Group Coherence

**Status: proposal.** Nothing in this document is implemented. It sketches a single
mathematical foundation for four of the Future Directions listed in
[web-of-trust.md](web-of-trust.md) — Discovery, Transitive trust, Group reputation,
and Decay — built entirely from conventions already in the codebase.

## What we have today

Two building blocks already exist in `get_contact_trust_summary`
([contact-details-schema.sql](../sql/contact-details-schema.sql)):

- **Time decay.** Every vouch contributes `2^(-age / 2 years)` — a vouch from two
  years ago is worth half of one made today.
- **A fixed two-hop signal.** The Trusted component sums vouches sent to a contact
  by mutuals the caller has personally given an "I trust you" vouch.

The Trusted component is the seed of transitive trust, but it has three limits: it
stops at exactly two hops; it treats every trusted mutual identically, no matter how
much the caller actually trusts them; and it is an unbounded sum, so quantity of
vouches can outweigh quality of the people making them.

## The idea: trust attenuates with distance the way it fades with age

Extend the halving rule from time to the graph. A vouch that reaches you through one
extra hop of trust is worth half of one made by someone you trust directly:

```
contribution of a vouch  =  2^(-age / T_half)  x  2^(-hops / D_half)

T_half = 2 years   (existing time half-life)
D_half = 1 hop     (proposed distance half-life, tunable)
```

The **transitive trust** the caller holds for a person `x` is the sum, over every
attester `a` who ever vouched for `x`, of `a`'s time-decayed vouches weighted by the
caller's (attenuated) trust in `a` — computed along 'trust' vouch chains out to a
bounded depth (3 hops). Depth 1 is exactly today's Trusted component; this is its
natural continuation, not a replacement.

Formally this is a truncated diffusion on the vouch graph — the same family of
computation as random-walk trust (personalized PageRank) and heat-kernel
propagation — but at Union's scale it is implementable as one bounded recursive SQL
query inside a `SECURITY DEFINER` function. No new infrastructure.

## Why this exact shape

### 1. Sybils cannot manufacture trust

The load-bearing property: **trust flowing into any cluster of accounts is bounded
by the vouch weight crossing the boundary into that cluster.** A thousand fake
accounts vouching for each other in a ring gain nothing from any real user's
perspective unless real people vouch across the boundary — and each real vouch
admits at most a fixed, decaying amount of flow. Trust becomes something you can
only obtain from humans, never mint.

This matters beyond contact screens. If FairShare currency is ever gated or priced
by trust, the trust quantity must be one that cannot be inflated from inside a
cluster of colluding accounts. Diffusion with per-hop attenuation has exactly this
cut-bound property; raw counts (today's sums) do not.

### 2. It degrades gracefully

Attenuation is exponential, so distant vouches contribute vanishingly little and
truncating at depth 3 discards at most a `2^-3` fraction of the signal. No cliffs,
no surprises when the graph grows.

### 3. It stays explainable in one sentence

The app already teaches users one rule: *worth half after two years.* This adds the
same rule in a second dimension: *worth half per extra hop.* The Trust Details
dialog explanation grows by one clause, not a paragraph.

## What it unlocks

| Future direction (web-of-trust.md) | With diffusion |
|---|---|
| Transitive trust | The score itself: "trusted by people you trust," to depth 3, weighted by how much you trust the intermediaries. |
| Discovery | Rank people you haven't met by transitive trust from your position in the graph. Show the score — never the path. |
| Group reputation | The Candidates screen shows each candidate's transitive trust from existing members, giving endorsers a principled signal beyond the sponsor's message. |
| Decay | Already inside the kernel — one constant per dimension, both user-legible. |

## Group Coherence: a related, separate number

Groups admit a complementary metric. Build the graph of vouches *among a group's
active members* and compute its **algebraic connectivity** (the second-smallest
eigenvalue of the graph Laplacian, the Fiedler value). This is the standard measure
of whether a network is one community or two cliques joined by a thread:

- **High** when vouching spans the whole membership — the group moves as one flock.
- **Low** when the group is quietly fragmenting into sub-cliques, *before* it is
  visible in chat activity or membership churn.

Normalized 0–100, this is a "Group Coherence" stat on the group page. It is cheap —
for groups of realistic size it computes in milliseconds by power iteration, nightly
and cached. Later it could inform constitution mechanics (e.g. admission thresholds
that keep coherence above a floor), but the observable stat alone is valuable.

## Privacy model

These are constraints, not features. Every mechanism above must preserve the
guarantees in [web-of-trust.md](web-of-trust.md):

1. **No path enumeration, ever.** Every RPC returns a single aggregate number.
   Nothing reveals *via whom* trust flows — a "trust path" display is explicitly
   rejected here, because any path rendering exposes private vouch and contact
   edges of third parties.
2. **No new readable rows.** The `attestations` table keeps no SELECT policy; all
   computation stays inside `SECURITY DEFINER` functions.
3. **Bucketed display.** Transitive scores follow the heart-dialog rules: fully
   hidden below a threshold, floored to buckets above it, so a single new vouch
   cannot be detected by watching a number move.
4. **Recipients never learn attesters.** Transitive trust is always the *caller's*
   view of a *third party*; the reverse direction (who feeds *my* score) is never
   queryable, matching `get_contact_history`'s one-direction rule.

## Implementation sketch

Three phases, each independently shippable:

1. **Deepen the Trusted component.** Inside `get_contact_trust_summary`, replace
   the fixed two-hop Trusted query with a recursive CTE over 'trust' attestations,
   applying `2^(-d / D_half)` per hop, depth capped at 3, fan-out capped per node.
   Reuses the existing `contacts.trust_score` cache. New constants sit next to
   `c_decay_a`: `c_hop_half`, `c_max_depth`.
2. **Discovery / group reputation RPC.** A function returning bucketed transitive
   trust for the sponsorship and endorsement flows (candidate screens first — the
   moment members most need a signal about someone they haven't met).
3. **`get_group_coherence(group_id)`.** Laplacian power iteration in plpgsql or an
   edge function, computed nightly per group and cached.

## Open questions

- **Constants.** `D_half`, depth cap, and bucket sizes should be picked by
  simulating on production-shaped graphs, not by intuition.
- **Low-degree inference.** For users with very few contacts, even bucketed
  aggregates can leak who vouched. The "fully hidden below N" rule likely needs a
  larger N for transitive scores than for direct counts.
- **Which vouch types propagate?** Proposal: only 'trust' carries flow across hops;
  other types ('love', 'respect', 'help') contribute at depth 1 only, since their
  meanings are not transitive.
- **Cost.** A depth-3 recursive query over `attestations` is fine at current scale
  but wants the same caching pattern `trust_score` already uses; worth measuring
  before Phase 2.
