# A stage's approval is invalidated by any commit landing after it, not just by an explicit rejection

Amends ADR-0014. That ADR's auto-merge trust boundary is "the Pull Request's
reviewer votes" — on detecting an approval vote, gantry completes/merges the
PR itself. It didn't address what happens if the branch moves *after* that
vote was cast: because WIP continues freely on a stage's branch throughout
the stage (also ADR-0014), and the PR always tracks that branch directly (no
snapshot), a save landing after approval silently becomes part of an
already-"Approved" PR with no further review. Checked directly against this
project's own Azure DevOps policy configuration: no "reset votes on push"
branch policy is configured, so Azure DevOps itself does nothing here — an
approval vote stays recorded as-is regardless of what lands on the branch
afterward. The entire gate is gantry's own reading of that vote; nothing
upstream protects it.

Gantry now treats a commit landing after the stage's approval as
invalidating that approval for auto-merge purposes, even though Azure
DevOps's own UI still shows the PR as "Approved." "Check status" no longer
treats "has an approval vote" as sufficient; it also checks whether the
PR's commit history has anything newer than the vote itself. This is a
gantry-side check, not a native Azure DevOps capability — the PR's true
reviewer-facing status can visibly diverge from what gantry is willing to
act on, which is why the invalidated state actively resets the vote via the
Azure DevOps API (making the two agree again) rather than leaving gantry's
belief silently out of sync with what a reviewer sees when looking at
Azure DevOps directly. If the vote-reset call turns out to be
permission-gated for gantry's own service identity, the fallback is
posting an automated comment flagging the new commits instead, leaving the
vote itself untouched — a weaker, comment-only signal, not a silent no-op.

Every commit that's ever landed on the PR — before or after approval — is
now surfaced in the Request Approval panel as a plain list (timestamp,
note), not just the invalidation state. This isn't a separate feature: it's
the same underlying data (the PR's commit history) serving two purposes —
reassurance pre-approval ("your changes are already queued, nothing extra
to do"), and evidence post-approval ("here's exactly what's new since the
reviewer signed off").

Alternatives considered and rejected:

- **Any post-open commit invalidates approval**, not just post-approval
  ones — rejected: a commit that landed *before* approval was ever cast is
  already what the reviewer saw (or chose to review whenever they got to
  it); there's nothing to invalidate. The only moment content can go stale
  relative to a decision is after that decision exists.
- **Informational-only nudge, no change to auto-merge** — rejected: a
  notice a human might miss defeats the reason the gate exists. If gantry
  can detect the risk, it should refuse to act on stale approval, not just
  mention it.
- **A brand-new "Request approval again" button for every case, including
  pre-approval edits** — rejected once it was clear pre-approval commits
  are already part of the PR's diff automatically (it's the same branch);
  a button implying an extra action is needed there would be actively
  misleading. The button only appears once there's a genuine invalidated
  state to resolve.

Status: accepted.
