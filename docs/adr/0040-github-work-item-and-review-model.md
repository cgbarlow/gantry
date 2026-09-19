# How GitHub carries work items, review status and people

GitHub ships at full parity with Azure DevOps — content store, stage branches, PR-gated sign-off, work-item linking, Request Review, identity lookup and Promote all in the first release. Four parts of the Azure DevOps model have no direct GitHub equivalent, and each needs a decision that a future reader would otherwise find inexplicable.

## Decision

**Review status rides reserved labels.** `lib/reviewStatus.js`'s five-value lifecycle (Requested, In review, Changes requested, Approved, Rejected) lives in the Azure DevOps custom field `Custom.GantryReviewStatus`, per `docs/adr/0024`. GitHub issues have no custom fields, and open/closed cannot carry five values. Gantry uses five reserved labels — `gantry:review/<status>` — created on demand. They are native to issues, visible and filterable in the GitHub UI, and readable from the same fetch that already retrieves the issue.

**Request Review keeps the Azure DevOps shape: one issue per reviewer.** Azure DevOps needs one work item per reviewer because `AssignedTo` holds a single person. GitHub has no such constraint — issues take multiple assignees. Gantry mirrors the Azure DevOps shape anyway, deliberately reproducing a workaround GitHub does not need, so that Request Review stays one concept with one behaviour across providers. A single multi-assignee issue could not carry per-reviewer status, which is exactly what the Work item details card displays.

**Work-item type is dropped on GitHub, not emulated.** Azure DevOps work items have a type (Task, Bug, User Story, Feature, Epic) and the "+ New Workspace" wizard collects one for the parent link. GitHub issues are untyped, so the wizard omits the field entirely for a GitHub workspace rather than manufacturing it from labels. Provider-discriminated wizard fields are already normal under `docs/adr/0037`. Hierarchy uses GitHub's native sub-issues where available, falling back to a task list in the parent body plus `Part of #<n>` in the child.

**Sign-off maps review states directly and merges with a merge commit.** `APPROVED` and `CHANGES_REQUESTED` map to their gantry equivalents; `COMMENTED` and `DISMISSED` read as still-pending, preserving `docs/adr/0014`'s distinction between a real verdict and an absent one. Gantry completes the PR itself with a merge commit, matching Azure DevOps' default and keeping "release tags go on the merge commit on `main`" true. A refusal from branch protection or a required check is surfaced verbatim as a blocked sign-off — never retried, never worked around, never downgraded to another merge method. The human resolves it in GitHub.

**The person picker unions collaborators with org members, and gates assignment on access.** Azure DevOps resolves names against the organization's identity directory. GitHub's equivalent is the union of the repo's collaborators and, where the repo is org-owned, the org's members — resolved through the per-user permission endpoint, so access granted via a team counts rather than only direct collaboration. GitHub rejects an issue assignee who lacks repo access, so a person who resolves but cannot be assigned is shown and blocked at selection, with the user told to grant repo access directly or through a team and retry. Gantry-side person fields (workspace Owner, library-repo code owner) are unaffected, since they never become a GitHub assignee.

## Alternatives considered and rejected

- **A structured marker in the issue body** for review status. Rejected: invisible as status in the GitHub UI, and destroyed by any human editing the body.
- **GitHub Projects v2 custom fields** for review status — the genuine structural equivalent. Rejected: a separate GraphQL API, a Project that must exist, every issue added to it, and broader PAT scopes, to reach a fidelity labels already deliver.
- **A single multi-assignee issue** for Request Review. Rejected: it cannot express "Ana approved, Sam wants changes", which the UI already shows.
- **GitHub's native PR review requests** for Request Review. Rejected: it collapses Request Review into Sign-off, when `CONTEXT.md` is explicit that these are different people, different mechanisms and different work items — and Request Review is available before the gate passes, when no PR need exist.
- **`gantry:type/*` labels** mirroring Azure DevOps work item types. Rejected: it manufactures a concept GitHub users do not have.
- **GitHub's org-level issue types.** Rejected: org-scoped and admin-configured, so gantry could not create a workspace on a personal repo at all.
- **A per-workspace merge method** (merge/squash/rebase). Rejected: stage branches are stacked on the preceding stage's branch while its PR is open (`CONTEXT.md`, Stage branch), and rebasing mid-stack is genuinely hazardous.
- **Detect approval but leave merging to a human or to auto-merge.** Rejected: it lets the stage pointer advance while `main` does not reflect it.
- **Global GitHub user search** for the person picker. Rejected: broader than Azure DevOps' org scope, and it offers people who cannot be assigned.

## Consequences

- `gantry:review/*` labels are repo-wide and human-editable, so someone can hand-set a status contradicting gantry's own record. This is the same exposure the Azure DevOps custom field already carries and is accepted on the same terms.
- Request Review on GitHub creates more issues than a GitHub-native design would. Accepted as the price of one cross-provider concept.
- The person picker costs an access check per candidate beyond the collaborator list.
- Fine-grained GitHub PATs need contents, issues, pull-requests and metadata permissions set explicitly, and an insufficient scope returns 404 rather than 403 — a misleading failure that belongs in the wizard's PAT help text and the user guide.

Status: accepted. Decided during the first-class-GitHub-support grilling session, 2026-09-18, ahead of implementation.
