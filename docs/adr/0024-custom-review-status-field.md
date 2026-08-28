# A custom status field carries review/sign-off outcome, additive to native ADO state

ADR-0023 deliberately deferred a custom approve/reject outcome for "Request
Review" work items, reasoning that native ADO state (done/not done) was
enough to start. WI213 (consolidating review/sign-off UX into the Work Item
Detail card) and WI214 (this ADR's trigger) now need to distinguish more
than done/not-done: a reviewer who requested changes reads identically, in
native state, to one who's still mid-review. Sign-off's PR-approval reading
(ADR-0014) has the same limitation. Both need a real outcome vocabulary:
requested, in review, changes requested, approved, rejected.

**Decision**:

1. Add one Gantry-owned custom field carrying this five-value lifecycle
   (`Requested` / `In review` / `Changes requested` / `Approved` /
   `Rejected`), applied uniformly to **both** Review and Sign-off work
   items — one vocabulary, not two, now that the gap was noticed for both
   at once.
2. The field is **additive**, layered alongside native `System.State`, not
   a replacement of it. `System.State` continues to drive Azure DevOps'
   own board/workflow mechanics (New/Active/Closed transitions) unchanged;
   the new field is what Gantry's own UI reads and writes for the
   richer lifecycle.
3. Gantry's status-reading logic (review status checks, sign-off status
   summaries, and any unified "Check status" action) reads this field as
   the source of truth going forward, rather than inferring outcome from
   native state.
4. Existing review/sign-off work items created before this field existed
   are read as `Requested`/`In review` (inferred from native state) until
   next transitioned — no forced backfill migration.

This **supersedes ADR-0023 §3 and its "custom approve/reject" rejected
alternative** — that decision explicitly anticipated being revisited "if it
turns out to be needed," and WI213/WI214's UX consolidation work is that
trigger.

Alternatives considered and rejected:

- **Full replacement of `System.State`** (define the five lifecycle values
  as the work item type's actual states) — rejected: verified against this
  project's live Azure DevOps `Task` process, `System.State` is a
  constrained process field with a fixed New/Active/Closed/Removed state
  machine. Writing any other value is rejected by the API. Making this the
  literal states would require an Azure DevOps process-template
  customization (an org-admin action outside Gantry's code), turning a
  code ticket into an infrastructure prerequisite — out of proportion to
  the problem.
- **Separate vocabularies for Review vs. Sign-off** — rejected: once
  sign-off's identical need was noticed, keeping the language the same
  removes duplicate concepts users would otherwise have to learn twice for
  materially the same status meaning.

Status: accepted.
