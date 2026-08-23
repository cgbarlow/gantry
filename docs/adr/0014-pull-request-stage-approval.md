# Stage approval happens via a Pull Request the Owner reviews, not a work-item state

Supersedes ADR-0012's ticketing-mode mechanism. ADR-0012 read a linked work
item's state as the approval signal — but a Workspace-backed instance
always has a real Azure DevOps repo behind it, and Azure DevOps Pull
Requests already have a first-class reviewer/approval concept that maps
directly onto "the Owner approved this," rather than inferring approval
from a work item happening to land in some Completed-category state. This
is also more consistent with gantry's own stated principle that git gives
you review, branching and history for free.

We're changing the mode-selection axis this repo has used since ADR-0012.
The split is no longer "does the Workspace have a ticketing system
configured" — it's **local instance** (no forge, self-serve advance only,
unchanged from ADR-0012) versus **Workspace-backed instance** (always
PR-gated, regardless of whether a ticketing system is separately
configured). Where a ticketing system *is* configured, the linked work item
(#99/#103) keeps its existing role unchanged — board-visible tracking
(title, status, assignee) — but no longer has any part in gating
advancement; that's the PR's job now.

For a Workspace-backed instance, a branch exists continuously from the
moment work on a stage begins — `main` only ever reflects fully-approved,
merged stages. If an earlier stage's branch/PR is still open, the next
stage's branch stacks on top of it, so work continues in sequence without
waiting on approval latency. Committing to the branch is unrestricted
throughout the stage. The actual approval gate — the Pull Request itself —
is only opened when the Assignee explicitly requests approval, still gated
on that stage's gate having passed (the same rule ADR-0012 already
established, now gating "open the PR" instead of "push a work-item state").
Gantry renders the artefact and commits it to the branch automatically on
every save throughout the stage, so the PR's diff always includes both the
module files and the actual generated document, not just markdown.

Detecting the Owner's approval still uses the same shape ADR-0012 chose —
an explicit, user-triggered "Check status" action, never polling or a
webhook — except it now reads the PR's reviewer votes instead of a work
item's state, and distinguishes an explicit rejection/changes-requested
vote from a merely-still-pending one, so the Assignee sees "rejected"
rather than an ambiguous "not yet approved." On detecting approval, gantry
completes/merges the PR itself, the same auto-act-on-detection shape
ADR-0012 chose for pushing a work-item state.

New surface this requires, beyond what ADR-0012 already added: branch
creation, and an entirely new Pull Request client (create a PR, read
reviewer votes, complete/merge a PR) — gantry has had no PR capability
before this. Nearly every existing Azure DevOps read/write path
(`lib/azureDevOpsClient.js`'s `getFileContent`/`writeFile`/`listFolder`,
and every consumer — `evaluateStageFromAzureDevOps`, `checkAzureDevOpsRepo`,
the render pipeline) is hardcoded to a single `main` branch today and needs
to target a specific stage's branch instead.

Alternatives considered and rejected:

- **A branch created only at the moment of requesting approval** (a
  snapshot of whatever's already on `main`, with WIP continuing to happen
  directly on `main` exactly as it does today) — a far smaller change,
  touching only the "request approval" action rather than nearly every
  storage read/write path. Rejected in favor of continuous WIP-on-branch:
  it keeps `main` always in a known-good, approved state, which matters
  more here than the smaller migration cost.
- **Forking each stage's branch fresh from `main`** rather than stacking on
  the prior stage's branch — rejected because it would leave a stage's
  branch missing the immediately preceding stage's own not-yet-approved
  work, which is confusing for something inherently sequential.
- **Owner merges the PR manually in Azure DevOps** rather than gantry
  auto-completing it — rejected for the same reason ADR-0012 rejected
  manual work-item state changes: one "Check status" click should get you
  a fully resolved state, not require a second manual step elsewhere.

Status: accepted.
