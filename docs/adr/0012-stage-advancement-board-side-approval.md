# Stage advancement is explicit, and ticketing-mode approval happens in the board, not in gantry

No mechanism has ever existed anywhere in gantry — UI or CLI — that moves an
instance from one stage to the next. `evaluateStage` only reports
gate-completeness for whatever stage is already recorded; nothing writes a
new one. Building that mechanism now, on top of #103's existing one-way
push sync (gantry → linked Azure DevOps work item, behind a human
confirmation), raises the real question this ADR settles: who is allowed to
advance an instance, and how does a ticketing-system-configured Workspace
layer approval on top of that.

We're building two modes, selected by whether the instance's Workspace has
a ticketing system configured (see the Workspace concept, README.md):

- **No ticketing system**: a self-serve "Advance to next stage" action,
  gated on the stage's gate having passed, available to anyone with access
  to the instance, behind a confirm dialog. Advancing is gantry's own state
  change; nothing is pushed anywhere else.
- **Ticketing system configured**: the Assignee marks the stage complete,
  which pushes the work item's state via the existing one-way sync. The
  Owner's approval happens **directly in Azure DevOps Boards** — gantry has
  no separate in-app "approve" action. Gantry detects the approval via a
  new, explicitly-triggered **"Check status"** action that reads the linked
  work item's current state back from Azure DevOps; if that state is in the
  Completed category, gantry advances its own stage record at that moment.

In both modes, the completion/advance request is blocked client-side unless
the gate has genuinely passed (the same rule #103 already uses for its own
sync-confirmation gate). Multiple stages may be pending approval
concurrently — advancing one stage never blocks starting the next. The
approval requirement applies uniformly to every instance in a
ticketing-enabled Workspace; there is no per-instance opt-out.

Why: the alternative — full automatic polling, or a webhook listener, to
detect the Owner's approval — was rejected. It requires standing
infrastructure (a poll loop or a webhook receiver) this deployment doesn't
have and wasn't asked for, when a single explicit "Check status" click,
driven by whoever actually wants an answer right now, gets the same result.
Keeping the Owner's approval act inside Azure DevOps Boards itself, rather
than adding a second "approve" button inside gantry, was also deliberate:
the Owner very likely already lives in the board day-to-day for exactly
this kind of sign-off, and a duplicate approval surface inside gantry would
just be a second place the same decision could be made inconsistently.

New surface this requires: gantry's Azure DevOps work-items client
(`lib/azureDevOpsWorkItemsClient.js`) has so far only ever created and
updated (written) work items, plus read a work item *type's* valid state
names (`getWorkItemTypeStates`) — it has never fetched a specific work
item's own current field values. "Check status" is the first thing that
needs that read.

Status: superseded by ADR-0014. The "no mechanism for stage advancement
exists yet" problem statement, the self-serve no-ticketing-system mode, and
the gate-fail/multi-stage-in-flight/no-opt-out rules all still stand as
written here. What ADR-0014 replaces is specifically the ticketing-mode
*mechanism* — a Pull Request the Owner reviews, rather than a work item's
state — once it became clear a Workspace-backed instance always has a real
git repo behind it, which a Pull Request fits far more precisely than an
inferred work-item state category.
