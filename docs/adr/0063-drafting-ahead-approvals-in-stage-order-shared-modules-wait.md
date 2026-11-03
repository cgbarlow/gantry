# Drafting ahead: approvals in stage order, shared modules wait

Ticket #247, map #238 (v0.13.0, the AI interview). Builds on the draft-ahead
research in #239.

In a remote workspace a stage moves on only when its Pull Request merges, and
the Owner may take days to approve. The AI interview keeps working meanwhile:
it **drafts ahead** on later stages, each stage branch stacked on the one
before (ADR-0014), up to the session's "run until" target.

Two rules make that safe.

**Approvals go in stage order.** Request approval and Check status refuse a
stage that isn't the instance's current stage on `main`. Today they accept any
gate, and approving a drafted-ahead stage first would carry the earlier
stage's unapproved commits into `main` and pass its gate without its own
sign-off. A stage that is ready while an earlier one is still pending shows as
**approval queued**; its Pull Request opens automatically once the Check
status that sees the earlier stage merge has run. The Owner only ever sees the
Pull Request that is next in line.

**Shared modules wait.** While a stage's Pull Request is open, nothing is
written to a module that stage also mounts. A drafted-ahead stage gets a
**head start**: the AI drafts only the modules no pending stage uses. The
Fields it would extend in shared modules wait until the earlier stage merges,
so a drafted-ahead stage usually reaches its stage-end card only after that
merge. When nothing draftable is left, the session offers "Check approval
now" or "Stop here", and confirming saves the head-start work.

Approval is still detected only by an explicit action, never polling
(ADR-0014): the architect's Check status click, the stage-end confirm, or that
waiting card.

## Consequences

- If the Owner requests changes on an earlier stage, the revision lands on
  its own branch and merges into `main` without conflict, because no later
  branch touched its modules. Later drafts may still be out of date. Gantry
  finds the later Fields drafted from changed content and the AI asks to keep
  or redraft each one.
- In Definitions where most modules are shared (13 of 22 in `design`), the
  head start is small. That is the price of never conflicting.
- Drafted-ahead branches still block re-opening an earlier stage (ADR-0026).

## Considered options

- **Open a later stage's Pull Request early and refuse to merge it out of
  order.** Rejected: the Owner would review the earlier stage's unapproved
  changes inside it, and could approve the wrong one first on the Provider.
- **Draft shared-module extensions and hold them unsaved** until the earlier
  stage merges. Rejected: the work is lost if the browser closes.
- **Write shared modules anyway** and resolve conflicts when an Owner
  requests changes. Rejected: Gantry has no sync on GitHub (ADR-0026 rejected
  auto-rebase), so the conflict would surface only at sign-off, as the
  Provider's refusal.
- **Draft only one stage ahead.** Rejected by the product owner: stacking
  already supports more, and the shared-module rule keeps each extra stage
  safe.
