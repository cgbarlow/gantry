# An Artefact can be excluded from satisfying its Gate

Amends ADR-0019, which made a Gate pass when any one of its Artefacts is
complete.

Under ADR-0019 every Artefact whose `gate` matches a Stage's gate is an equal
way through that Gate. `evaluateStage` in `lib/status.js` works out each
Artefact's completeness against its own `requires`, and the Stage is complete
when any one of them is. That was the right rule for the case it was written
for, a lightweight SOAP and a full SOAP, where either document is a real record
of the decision.

## Why that is no longer enough

Spec #147's review of `recruitment-onboarding` v2 found that the rule shapes
what documents can hold. An Artefact written for a reader outside the process
owner's team, such as the Offer Pack sent to a candidate, should carry only
what that reader needs. But if it carries fewer Fields than the internal record
at the same Gate, it becomes the easy way through the Gate: complete the short
document and the Stage can be signed off with the internal record half written.
So v1 gave every Artefact at a shared Gate the same core Field set, and every
template printed everything in its `requires`. The candidate's document ended
up with the organisation's internal open questions, Payroll's re-send history
and staff names.

Nothing in a Definition could say "this document is produced at this Gate, but
it isn't what the Gate is signed on".

## Decision

1. **An Artefact can set `satisfies-gate: false`.** That Artefact never makes
   its Gate pass on its own. The Gate passes when any one Artefact that does
   satisfy it is complete. The key defaults to `true`, so an Artefact without
   it, or with `true`, counts exactly as before, and existing Definitions are
   unaffected.
2. **Its completeness is still worked out and reported.** The gate check's
   result carries each gate Artefact's `complete` and `outstanding` as before,
   plus a `satisfiesGate` flag. The same holds in the Local Workspace twin
   (`web/lib/localStatus.js`), which must give the same result as the server.
3. **It is still produced for approval.** When it is complete it is rendered,
   verified and linked in the approval request beside the Artefact that passed
   the Gate, so the approver sees what will be sent. When it is incomplete it
   is skipped, as any incomplete Artefact already is (ADR-0019's own "not
   changed" paragraph). The flag decides whether the Stage can advance, not
   which documents get produced.
4. **A failed Gate names an Artefact that can pass it.** Every gate-failure
   message (`gantry check`, stage advancement, the approval request, the web
   sign-off and advance panels, the dashboard's Check) reports the closest
   incomplete Artefact among those that satisfy the Gate. An excluded Artefact
   is never named, however few Fields it is missing, because completing it
   would not help.
5. **A Stage where every Artefact opts out is a problem.** If a Stage has at
   least one Artefact at its gate and every one of them sets
   `satisfies-gate: false`, the Gate can never pass. That is an
   `unsatisfiable-gate` problem, reported by `gantry validate`, marked on the
   Stage on the Definitions page and in a Local Workspace, and refused at Save
   and Publish. A Stage with no Artefacts at all is not flagged: it has nothing
   to exclude, and is usually a Definition still being written. Like #149's
   gate-id problems, it does not stop a Definition loading, so an instance
   already running on one keeps working after an upgrade.
6. **It is visible where people work.** The Definitions page has a
   "Completing this artefact passes its gate" checkbox per Artefact, ticked by
   default. Unticking it stores `satisfies-gate: false`; ticking it again
   removes the key rather than writing `true`, so a Definition that never uses
   the switch keeps its YAML unchanged. #148 made the key survive save, new
   draft, clone, publish, promote and the Library cache. The instance editor
   keeps the Artefact in its selector with a "doesn't count toward the gate"
   hint. `gantry check` lists each Artefact's completeness and whether it
   counts toward the Gate, and the MCP `check_gate` description explains the
   flag.

## What this gives up

An author can no longer read "the Gate passed" as "every document at the Gate
is complete", and never could under ADR-0019. What changes is that one
document at the Gate may be complete while the Gate still fails. The check
output, the editor hint and the failure message all say which document the
Gate is waiting on, so this is shown rather than left to be worked out.

Nothing here checks that the satisfying Artefact covers what the excluded one
prints. A Definition author who excludes the candidate's document is expected
to make an internal Artefact at the same Gate carry those Fields, as
`recruitment-onboarding` v3 does.

## Alternatives considered

- **Require every Artefact at a Gate.** Rejected for the reason ADR-0019 gave:
  it would force the lightweight and full SOAP to both be written.
- **Name the one Artefact that satisfies a Gate on the Stage** (a
  `gate-artefact:` key). Rejected: it can't express a Gate that two documents
  can each satisfy, such as `recruitment-onboarding` v3's Starter Readiness or
  Hire Record, and it moves a fact about an Artefact onto the Stage.
- **Leave audience documents out of the Definition** and write them by hand.
  Rejected: they would lose the render pipeline, the filename pattern, the
  approval link and the Document Control opt-out (ADR-0049) that exist for
  exactly these documents.

Status: accepted.
