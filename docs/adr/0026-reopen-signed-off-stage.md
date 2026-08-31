# Re-open a signed-off stage for late feedback

WI #265. Once a workspace-backed instance's stage is signed off (its approval PR merged, instance advanced) there is no supported way back. A completed stage's branch is deleted on PR completion and `main` only ever reflects fully-approved content, so the module editor reading that completed stage from `main` is read-only — late feedback (a reviewer comment after sign-off, a missed field) has no first-class path short of manually creating a branch, resetting the stage pointer, and hoping the next PR does not silently overwrite prior approvals.

## Decision

### Trigger — Re-open stage button

A **Re-open stage** button in the module editor, shown only when free-browsing a *completed* stage — i.e. `definition.stages.findIndex(viewedStage) < definition.stages.findIndex(instance.stage)` — for a workspace-backed instance. Gated behind the same PAT/permission check as "Request sign-off" (the effective required reviewer identity resolution and PAT scopes already governing that action). Not shown on the current stage, not for local instances, not in Rendered view. Clicking it opens a confirm dialog; confirming transitions the editor into the re-opened editing session.

### Re-open action (`POST /api/instance/stage/reopen?slug=&stage=`)

- Recreate the stage branch (`gantry-workspace/<slug>/<stageId>`) from current `main` (approved content as starting point). If it already exists, 409.
- Set the instance's `stage` pointer back to that stageId, and add an `instance.yaml` field recording the re-open + preserving prior approval history — `reopened: { <stageId>: { at: <ISO>, previousStage: <the stage that was current> } }`. Do NOT delete the existing `pullRequests`/`workItem.stages` records.
- Normal editing / save / render-to-branch resume for that stage (same `resolveStageBranch`/render pipeline as any other stage).

### Guard — later stage in progress

If any stage after the one being re-opened already has a branch (`findStageBranch` returns one) or the instance had advanced more than one stage past it, reject with a clear 4xx: `Stage '<later>' is already in progress — complete or abandon it before re-opening '<earlier>'.` No auto-rebase in this cut.

### Completion — reuse existing approval machinery

The re-opened stage completes through the existing `requestStageApproval` machinery (fresh PR stage-branch → main, same gate check via `checkGate`, same approvers). On that PR's merge / stage advance, clear the `reopened` marker for that stage and re-advance to `previousStage` (or the next stage, whichever the normal advance logic yields — reuse it, don't reinvent).

### Audit

The re-open and re-approval must be visible — a commit on the stage branch (`Re-open stage '<id>' …`), and if the instance has a linked work item, a state/comment push noting the re-open (mirror how `syncGatePassToWorkItem` etc. already push state). Never silently rewrite.

### Completed-stage branch lifecycle (WI #262 clarification)

A completed stage has no branch unless re-opened. `GET /api/instance`'s stageSync advisory and `POST /api/instance/stage-branch/sync` already treat completed stages as "nothing to sync" / no behind check — this ADR documents that as the intended state rather than a leftover-branch bug to fix.

## Alternatives considered

- **Fork re-opened branch from the stage's pre-merge commit rather than current `main`** — rejected: `main` already contains the approved content, is the only ref `checkStageApprovalStatus` treats as the approved baseline, and forking from an older commit would silently drop later approved stages' content from the file tree.
- **Auto-rebase / auto-merge later in-progress stages onto the re-opened branch** — rejected for this cut: rebase semantics for YAML modules need product input; a clear rejection with the name of the blocking stage is safer.
- **Delete prior `pullRequests`/`approvalStates` on re-open** — rejected: prior approval history must remain auditable; a new PR id overwrites the map entry only on the next `requestStageApproval`.

Status: accepted.
