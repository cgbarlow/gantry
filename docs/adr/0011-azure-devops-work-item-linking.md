# Instance-level Azure DevOps work-item linking: per-stage auto-created children, confirmed read-write state sync

Spec #95 asked for an optional link from a Gantry instance to an Azure DevOps work item, with
Gantry auto-creating one child work item per stage under that parent, and a read-write sync that
pushes a stage's state to its work item once the corresponding gate passes — gated behind an
explicit user confirmation. #99 built the `lib/azureDevOpsWorkItemsClient.js` primitives
(`createWorkItem`/`createChildWorkItem`/`updateWorkItem`/`getWorkItemTypeStates`) this ticket (#103)
actually wires up; #99's own code comments named this ticket as the reason those primitives exist,
with no caller of their own.

## The link is instance-level, and independent of where the instance's own data lives

`instance.yaml` gains an optional `workItem` field — `{ organization, project, workItemType,
parentId, baseUrl?, stages: { [stageId]: childWorkItemId } }` — written once, at link time, by a
new `linkInstanceToWorkItem` (`lib/workItemLink.js`). This follows the exact same shape ADR-0008
already established for the instance's own descriptive `azureDevOps` field: written once, read back
verbatim, never reconciled against anything else. An instance with no `workItem` field is simply
unlinked — every existing code path is completely unaffected (#103's first acceptance criterion).

Critically, `workItem.organization`/`workItem.project` (where the *work item* lives, in Azure
DevOps Boards) are entirely independent of whichever backend stores the instance's own module data
(local filesystem, or a git-backed Azure DevOps repo via the pre-existing `azureDevOps` field) —
an instance can be locally stored yet linked to a work item in some Azure DevOps project, or
Azure-DevOps-backed for its data yet linked to a work item in a *different* project than its own
repo lives in. Nothing in this ticket assumes the two coincide, even though in practice they often
will. This is why linking takes its own explicit `organization`/`project`/`parentId` rather than
inferring them from the instance's own `azureDevOps` location.

## One child work item per stage, created eagerly at link time

Linking creates every stage's child work item up front, in one `linkInstanceToWorkItem` call —
not lazily, on first gate pass — because the acceptance criteria describe linking itself as the
trigger ("linking creates one child work item per stage"), and because a fully-populated board
structure immediately after linking is more useful to a team than one that fills in unpredictably
as gates are reached over the following weeks/months. A definition's stage list is fixed at load
time (`lib/definition.js`), so there's no later point at which a "new" stage could need a child
work item created after the fact.

Re-linking an already-linked instance is rejected outright (not idempotent, not silently ignored) —
the error names the existing parent work item id, so a caller who wanted to link to a *different*
parent, or made a duplicate request, can tell what happened rather than silently getting a second,
orphaned set of child work items alongside the first. Unlinking isn't supported at all yet — no
spec/acceptance criterion asked for it, and removing a link cleanly would also mean deciding
whether to touch/delete the now-orphaned Azure DevOps work items themselves, which is genuinely a
separate design question this ticket doesn't answer.

If a child work item's creation fails partway through the stage loop (a network blip, an expired
PAT mid-flow), the error names exactly which stages already got a real, now-orphaned Azure DevOps
work item created for them — mirroring `createInstanceInAzureDevOps`'s own partial-failure
reporting (ADR/#85) — rather than leaving the caller to guess what state Azure DevOps is actually
in. This ticket doesn't attempt to roll those back (Azure DevOps's REST API has no cheap
soft-delete-and-undo primitive to lean on) or retry automatically.

## Work item type: configurable, defaulting to "Task"

`workItemType` is a per-link parameter, defaulting to `DEFAULT_WORK_ITEM_TYPE = 'Task'` when the
caller doesn't supply one. "Task" is the one work item type every stock Azure DevOps process
template (Basic, Agile, Scrum, CMMI) ships as a valid child of a parent work item — types like
"User Story" (Agile/Scrum-only) or "Requirement" (CMMI-only) would silently fail to link for an
organization on a different template. An organization that wants its own process template's own
child type instead (e.g. "Product Backlog Item") passes `workItemType` explicitly.

## State mapping: driven by the work item type's own reported states, never a Gantry-invented list

The final acceptance criterion is explicit: a confirmed sync must push "a state drawn from the
configured work item type's actual valid states (not a Gantry-invented fixed list)". Different
process templates give the same work item type wildly different state *names* for the same
underlying meaning (Basic's Task: New/Active/Closed; Scrum's Task: To Do/In Progress/Done) — so
matching by name is a dead end. Azure DevOps's own state **category** (`Proposed`/`InProgress`/
`Resolved`/`Completed`/`Removed`) is the one thing that *is* comparable across templates, since
every template's own gate-closing state carries the `Completed` category regardless of what it's
actually called. `pickPassedState` (`lib/workItemLink.js`) calls `getWorkItemTypeStates` (#99) at
sync time — never caching a snapshot from link time, so a later change to the project's process
template is honoured automatically — and prefers a `Completed`-category state, falling back to
`Resolved`, and finally the type's last reported state, so a sync never fails outright just because
a custom/inherited process template happens to omit a `Completed`-category state entirely.

## Confirmation lives entirely client-side; the server only re-validates and pushes

"Gated behind an explicit user confirmation prompt before the write happens" is implemented as two
separate HTTP calls, not one call with a `confirm: true` flag: the existing (now dual-backend —
see below) `GET /api/instance/check` runs first, client-side, to determine whether the gate
actually passes; only a PASS opens a confirm/decline modal (mirroring the existing `PatPromptModal`
pattern in `web/app.js`); only *Confirm* issues the new `POST /api/instance/work-items/sync` call.
**Declining is not a distinct code path anywhere** — it's simply the absence of that second call,
so "declining leaves the work item's state unchanged" (the fifth acceptance criterion) is true by
construction rather than something the server has to specifically get right. The server-side sync
route re-runs `checkGate` itself before pushing anything (never trusting the client's own earlier
check result) — the same "never trust a client-reported precondition for a state-changing call"
posture every other mutating route in this codebase already takes.

## Fixed alongside: `checkGate`/`GET /api/instance/check` now actually supports Azure-DevOps-backed instances

Investigating this ticket surfaced a pre-existing gap: `lib/check.js`'s `checkGate` (and the server
route wrapping it) only ever read from the local filesystem — an Azure-DevOps-backed instance's
"Check" action silently checked a local directory that instance's data never actually lived in,
with no test ever having caught it. This ticket's own confirmed-sync flow needs a working check for
*either* backend, so `checkGate` gained the same `options.azureDevOps` dual-dispatch every other
function in this codebase already follows (`evaluateStage`, `readInstance`, etc.), and
`GET /api/instance/check` now resolves the instance's registry location and gates on a PAT exactly
like every other Azure-DevOps-backed route. Fixed here rather than filed as a separate ticket,
since #103 could not be correctly implemented without it.

## Alternatives considered and rejected

- **Infer `workItem.organization`/`project` from the instance's own `azureDevOps` storage
  location.** Rejected: conflates two genuinely independent concerns (where module data lives vs.
  where Boards work-item tracking lives) that the spec never said had to coincide, and would make
  linking impossible for a local (non-Azure-DevOps-backed) instance for no good reason.
- **Create child work items lazily, the first time each stage's gate is checked/passed.** Rejected:
  the acceptance criteria describe linking itself, not a later gate pass, as the trigger for
  per-stage child creation; lazy creation would also mean the board looks incomplete for however
  long it takes a team to reach each later gate.
- **Match a "gate passed" state by name (e.g. always push `"Closed"`).** Rejected outright by the
  acceptance criteria themselves — this is exactly the "Gantry-invented fixed list" they rule out,
  and would silently fail (or push a nonsensical state) against any process template whose Task
  type doesn't have a state literally named "Closed".
- **A single HTTP call with a `confirm: true` body flag, prompting client-side only as UI sugar.**
  Rejected: would make "declining" something the server has to specifically special-case (a
  `confirm: false` request that must do nothing) rather than something that's true merely because
  no request was ever sent — a strictly weaker guarantee for the same acceptance criterion.
- **Support unlinking/re-linking to a different parent in this ticket.** Rejected as out of scope —
  no acceptance criterion asked for it, and it raises its own separate question (what happens to
  the now-orphaned child work items) this ticket doesn't have grounds to answer unilaterally.

Status: accepted.
