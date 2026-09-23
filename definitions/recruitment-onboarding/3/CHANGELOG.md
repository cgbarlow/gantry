# Recruitment and Onboarding — changelog

## v3

**Status: prototype draft, on an unmerged branch.** Carries out every recommendation of the v2 field review (spec: the GitHub issue linked from this branch's README). Several keys here (`document-control`, `satisfies-gate`, `read-only-modules`) need Gantry engine changes that do not exist on main yet; today's engine ignores them and publishing would strip them.

1. **Appointment split into two stages.** `appointment` (gate `approved-to-appoint`, owned by the requesting department, sign-off = Executive Approval) and `offer-contract-payroll` (gate `onboarding-approved`, HR with Payroll). This overturns v1's "Four stages, not the source model's three phases" (v2 CHANGELOG.md:162-165).
   - Record one rule for both phases: both have an approval before a milestone. Phase 1 is only reworded, because nothing is promised to anyone before "Approved to Recruit". Phase 2 is split, because an offer and a signed contract reach an external person before any recorded approval.
2. **Requisition sign-off reframed** as the "Approved to Recruit" confirmation. Record the model's chain-before-evaluation order and the advisory-review route.
3. **New internal artefact `onboarding-case`.** `appointment-case` moves to `approved-to-appoint` and keeps candidate, rationale, vetting (now with conditions and the term) and the proposed offer terms.
4. **`offer-pack` replaced by `appointment-confirmation`** (id, title, template, filename). It is sent after onboarding approval. It no longer prints open questions, payroll history, the Payroll Manager's name, offer terms and status, signatures, or start-date changes.
5. **Audience documents** (Appointment Confirmation, Manager Handover) are `document-control: false` and `satisfies-gate: false` (E1, E3). Their `requires` is exactly what they print plus filename tokens. This overturns v1's "same core field set" arrangement (v2 CHANGELOG.md:156-160) for those two documents.
   - The v3 rules: satisfying documents share same-stage bare fields only, and every bare field at a gate is printed by at least one internal document there.
6. **Carried-forward fields** use `required-at` their home gate and are referenced `?` later (read-only mounts via E2). Exceptions: `selection.candidate-name` and `contract.start-date` stay `required: true` as filename tokens, and the Hire Record keeps every carried entry bare.
7. **Removed `engagement.approval-route`**, now derived from the type. This overturns v1's "the one part that is genuinely content" (v2 CHANGELOG.md:147-148) and the v2 option list signed off in 2235b50. **Added `engagement.route-variation`**, and the delegation text moves out of `rationale`.
8. **Replaced `contract.signatures`** with `contract.manager-signed` and `contract.candidate-signed` (dates, matching the model's attributes). Timing commentary moves to `elapsed`. Added `contract.variations`.
9. **Removed `handover.readiness-confirmation`.** Readiness is the ready-to-start sign-off, extending v1's "Approval is the stage sign-off" to New User Ready and overturning v1/v2's "who confirmed" guidance. The day-one readiness sentence is deleted, and the Manager Handover headline is derived instead.
10. **`payroll.validation-outcome` is now `required: false`** and absent from both onboarding-approved documents; `payroll.confirmed` carries the gate.
11. **Added `identity.user-id`**; `identity.account` is narrowed. **Added `device.standard`** (the model's attribute) and **`device.build-notes`**, which takes timing out of the specification.
12. **`access.outstanding` retitled** "Not in place by the start date" and now covers the device and identity too.
13. **`vetting.checks-required` gains "Identity verification"**, which the v2 example stored off-list.
14. **Personal-data guidance:**
    - remuneration as band and position in band, never the figure (`offer.terms`, `contract.terms-summary`);
    - never attach the executed contract;
    - vetting conditions written as the requirement to meet;
    - credentials recorded as channel, sender and date, never the password or address;
    - the candidate name with no other identifiers;
    - decline and rework recorded as reason categories;
    - a delegation recorded as to whom, never why.
    - Also note that instances hold HR personal data needing HR-file access and retention controls, with erasure covering git history and superseded filenames.
15. **Timing:** `contract.elapsed` is measured to the agreed start date and filled before onboarding approval; `selection.unsuccessful` can be completed after acceptance; the Manager Handover is rendered early and re-sent; the Hire Record is the record as at readiness sign-off; request Provisioning approval only once the Hire Record is complete.
16. **Scope and printing:** `open-questions` scope restated; `process-gaps` is authorable at every stage; `role-evaluation.method` stays printed in the brief as a closing section; Starter Readiness adds the team and candidate name and drops manager actions and first day; the Manager Handover drops team, account, propagation, credential issue, setup and open questions.
17. **Template markers and warnings:** "— not stated —" markers for the term, conditions and non-standard decision; warnings for Not cleared, an unaccepted offer, and a device not Ready.
18. **Correction to v2 (E5).** v2 CHANGELOG.md:96-100 says `selection.candidate-name?` "keeps it from changing either artefact's own gate-completeness bar". That is false. `?` only exempts fields that aren't otherwise required (`lib/status.js:107-115`); `candidate-name` is `required: true`, so it gated in offer-pack, starter-readiness and manager-handover all along. It worked by accident.
    - v3 writes those entries bare and prints the name in the Appointment Confirmation and Starter Readiness, which overturns v2's "never as a rendered section" for those two.
19. **Migration note** (see (6g)).

## v2

Typed Fields and filename patterns (#90, epic #77), applied on top of v1's process — same four
stages, same seven artefacts, same fourteen modules, no field renamed or removed except the two
splits below. v1 is unmodified and keeps working exactly as it always did.

**Status: draft, not published.** Every option list below is traceable to wording already in
v1's own guidance, but a published version is immutable, and confirming the exact wording with
the process owner before locking it in is this version's own stated acceptance criterion.
Publishing is a manual follow-up, not part of this change.

### Seven fields converted to `select` (ADR-0044)

Each was already a closed enumeration in v1's guidance prose. The dropdown now enforces what the
guidance only described.

| Field | Options | v1 wording it's drawn from |
|---|---|---|
| `engagement.type` | Fixed term, Permanent, Vendor, Contractor | "One of fixed term, permanent, vendor or contractor." |
| `engagement.approval-route` | Full approval chain, Shortened approval chain | "a fixed-term or permanent appointment takes the full approval chain, while a vendor or contractor engagement takes a shortened one" (module `purpose`) |
| `offer.status` | Extended, Accepted, Declined | "Extended, accepted or declined, with the date of each." |
| `vetting.outcome` | Cleared, Cleared with conditions, Not cleared | "Cleared, cleared with conditions, or not cleared, with the date each check completed." |
| `payroll.validation-outcome` | Passed, Failed | "Passed or failed, and when." |
| `device.build-status` | Requested, Built, Configured, Ready | "Where the device got to and when — requested, built, configured, ready." |
| `handover.readiness-confirmation` | Ready, Ready with outstanding items, Not ready | "Confirmation that account, access and device are all in place and the starter can work from day one... Where something is outstanding, say so here as well as in `access`." |

The "with the date"/"who confirmed it" qualifiers named in several of these guidance passages
are not preserved as a second field — a select stores one classification, not a classification
plus a date, and none of the seven was named in this ticket's own scope for a text/date split.
Where the surrounding module already had a natural home for that detail (`vetting.conditions`,
`payroll.rework`, `offer.negotiation`, `access.outstanding`), that field's own guidance was
extended to say so explicitly.

### Two fields converted to `select` + `multiple: true`

| Field | Options | v1 wording it's drawn from |
|---|---|---|
| `vetting.checks-required` | Right to work, Criminal record, Credit, Professional registration, Referee checks | "Which pre-employment checks apply to this role — right to work, criminal record, credit, professional registration, referee checks." |
| `advertising.channels` | Job boards, Careers site, Agencies, Internal channels, Professional networks | "Every place the role was advertised — job boards, the careers site, agencies, internal channels, professional networks." |

Both stored as bullets in v1 (`type: list`) and store as bullets in v2 too — the on-disk shape
is unchanged, only the value is now drawn from a fixed list instead of typed freely. The "name
the agency" instruction from `advertising.channels`' old guidance moved to `advertising.notes`,
since a select option can't carry a qualifying clause.

### Two fields split into a typed value plus narrative

- **`selection.preferred-candidate`** (markdown) → **`selection.candidate-name`** (`type: text`,
  required) + **`selection.rationale`** (markdown, required). v1 asked for "who was selected and
  why" in one field; v2 asks for the name once, as a fact, and the reasoning separately.
  `candidate-name` is also what names every document rendered from Selection onward.
- **`contract.start-date`** (markdown) → **`contract.start-date`** (`type: date`, required) +
  **`contract.start-date-changes`** (markdown, optional, new field id). v1's guidance said "the
  agreed first day. If it moved after being agreed, record the original date, the new one, and
  what moved it" in one field; v2 keeps the agreed date typed and the story of any change beside
  it. `contract.start-date` also names `offer-pack` and `starter-readiness`.

### One field gains a companion, not a split

`engagement.type` becomes a `select` on its own — the third instruction in its v1 guidance ("For
a fixed term or a vendor or contractor engagement, state the term or the expected duration
alongside it") became a new optional field, **`engagement.term`**, rather than a second value on
the select itself (a select's value is one string, not a string-plus-note).

### Left as prose, deliberately

`role-evaluation.method`, every field in `advertising` except `channels`, and
`device.non-standard-decision` are unchanged. v1 documents these as undocumented on purpose — the
record of where the real-world process has no defined path — and a dropdown would invent policy
nobody has agreed to. See each module's own `purpose`/guidance text, also unchanged.

### Filename patterns (ADR-0045) on all seven artefacts

| Artefact | Pattern |
|---|---|
| Requisition Brief | `{instance.name} - Requisition Brief` |
| Selection Report | `{instance.name} - Selection Report` |
| Appointment Case | `{selection.candidate-name} - Appointment Case` |
| Offer Pack | `{selection.candidate-name} - Offer Pack - {contract.start-date}` |
| Starter Readiness | `{selection.candidate-name} - Starter Readiness - {contract.start-date}` |
| Manager Handover | `{selection.candidate-name} - Manager Handover - {today}` |
| Hire Record | `{selection.candidate-name} - Hire Record` |

The first two render before a candidate is selected and are named from the instance itself, per
ADR-0045 §4/§10 — `selection.candidate-name` isn't in their `requires` at all, so a pattern
referencing it would have failed validation, which is the point. `offer-pack` and
`starter-readiness` carry the start date on top of the candidate name, since both are documents
a reader files by when the person starts. `manager-handover` carries `{today}` instead — it can
be re-sent close to the start date, and when it was produced is the more useful fact for a
manager filing it. `hire-record` is named from the candidate alone: it's filed once and kept, and
a start date that moves (`contract.start-date-changes` exists precisely because it does) should
not rename the permanent record.

`offer-pack`, `starter-readiness` and `manager-handover` did not carry any `selection.*` field in
v1 and still don't render one in v2 — `selection.candidate-name?` is in their `requires` only so
`filename:` can reach it (ADR-0045 §4 requires every referenced field to be in `requires`), never
as a rendered section, and the `?` keeps it from changing either artefact's own gate-completeness
bar.

### Template changes

Every template's `na()`/loop calls are unchanged for fields that kept their id and shape — a
single-valued select or a text field is still a plain string, and `select` + `multiple: true`
stores bullets identically to `list`, so nothing in a template needed to change for those.
`contract['start-date']` is now wrapped in the new `formatDate()` helper everywhere it renders,
so a reader sees "3 November 2026" rather than the stored `2026-11-03`; what's on disk is
unaffected. New optional sections (`engagement.term`, `contract.start-date-changes`) follow the
existing suppress-when-blank convention used throughout.

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
it. (v2 does not carry an equivalent — its field ids differ enough from v1's that reusing the
same example content directly would misrepresent it; a v2 example is left as a follow-up.)
