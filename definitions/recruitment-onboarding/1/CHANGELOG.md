# Recruitment and Onboarding — changelog

## v1

First version. Ported from a BPMN 2.0 process model, its supporting UML domain model, glossary
and written narrative, held in Iris under the Contoso Test Organisation collection. Ported
2026-09-21. See the provenance block at the top of `definition.yaml` for the exact sources.

### What it covers

One instance is **one hire** — it opens when a vacancy is identified and closes on the starter's
first day. Four stages, one exit gate each:

| Stage | Gate | Owner |
|---|---|---|
| Requisition | `approved-to-recruit` | The requesting department |
| Selection | `candidate-selected` | HR |
| Appointment | `onboarding-approved` | HR, with Payroll validating |
| Provisioning | `ready-to-start` | Technology |

Seven artefacts across those gates: **Requisition Brief**, **Selection Report**, **Appointment
Case** and **Offer Pack**, then **Starter Readiness**, **Manager Handover** and **Hire Record**.
Fourteen modules feed them.

### Decisions worth knowing before you author against it

**It models the current process, not a better one.** The source model is deliberately as-is and
keeps its weak points; so does this. Five of them are named in field guidance rather than
designed away — the payroll rework loop, credentials issued by email, the two undocumented
sub-processes, and the non-standard hardware decision that nobody has defined. If you are filling
these in and the honest answer is unflattering, write the honest answer. That is what the fields
are for.

**Approval is the stage sign-off, not a field.** The source process has an approval chain, an
"Approved to Recruit" milestone and an executive approval to appoint. None of them is a field
here. In Gantry an approval is the merged pull request behind a gate, and re-recording it as
authored prose would be a self-attested copy of something git already holds better. The one part
that is genuinely content — which route an engagement type commits the request to, full or
shortened — lives at `engagement.approval-route`. The `appointment-case` artefact is named for
what it is: the case put to the approver, not the approval.

**No candidate personal data.** `payroll` records that details were requested, supplied and
validated, and what failed — never a bank account or a retirement savings scheme election.
`vetting` records which checks applied and what they returned, never what a check surfaced.
Instance content is committed as plain files; none of that belongs in a repository.

**The gates are strict.** Nearly every entry in every artefact's `requires` is bare, so nearly
every field blocks. Where a gate carries more than one artefact, they all block on the same core
field set and differ only in what they add — so the shortest document at a gate is not the
easiest way through it. This is deliberately unlike the `design` definition's SOAP/full-SOAP
pairing, where the lighter document sets the bar on purpose.

**Four stages, not the source model's three phases.** The source has three phase groups but four
real decisions; Phase 1 alone holds both the approval to recruit and the selection of a
candidate. One gate per stage means a stage holding two approvals can only gate on the later one,
so Phase 1 is split at "Approved to Recruit".

### What the source model has and this does not

BPMN carries loops, parallel forks, swimlanes and durations. A Gantry definition carries none of
them. Four things therefore live in prose rather than structure, and their absence is not an
oversight: lanes are named in each stage's `purpose`; durations are quoted in the guidance of the
field they bear on; the payroll rework loop is recorded at `payroll.rework` and re-run as
`reopen_stage`; and the parallel identity and device paths are simply three modules on one stage.

### Example instance

`examples/platform-engineer` is a worked hire covering all four stages — a Contoso Platform
Engineer, offered March 2026, starting April. It is deliberately not a clean run: payroll
validation failed once and cost five days, the hardware was non-standard with no defined path for
deciding that, and the building access card arrived the day after the starter did. Every stage
carries `example: platform-engineer`, so the web form's "Populate example text" button fills from
it.
