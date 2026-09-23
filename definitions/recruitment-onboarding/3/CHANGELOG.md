# Recruitment and Onboarding — changelog

## v3

Carries out the field-by-field review of v2 against the Contoso Test Organisation process model
(spec #147). v3 starts as a copy of v2 (#153), and each later ticket records its change here.
v2 stays published and unchanged, so live v2 instances are unaffected.

**Status: draft, not published.** Publishing it, and migrating the platform-engineer worked
example and live v2 instances to it, is the process owner's step once the work is complete.

### Instances hold HR personal data

The description now says that instances hold HR personal data and need HR-file access and
retention controls wherever they are stored. It's in the description rather than a YAML comment
because comments don't survive publishing.

### Starter Readiness is written for Technology (#157)

Starter Readiness is Technology's provisioning record, so it now carries what Technology
provisions and nothing else.

- **It names the starter and their team.** Email groups, shared drives and directory placement
  follow the team, so Technology needs it. `selection.candidate-name` is now bare and printed,
  which **overturns v2's "never as a rendered section"** for this document. `role.summary` and
  `role.team` are in scope as `?`.
- **It no longer prints the manager's to-do list or the first day.** Technology acts on neither.
  `handover.manager-actions` and `handover.day-one` stay bare in its `requires`, unprinted, so it
  and the Hire Record owe the same Fields at ready-to-start. The Hire Record prints both.
- **A warning** appears when the device isn't Ready and nothing is listed as not in place by
  the start date: the stage shouldn't be signed off like that.
- **A non-standard device with no recorded decision** prints the Non-standard hardware decision
  heading with "— not stated —", so the gap is visible.

New Fields:

| Field | Type | Why |
|---|---|---|
| `identity.user-id` | text, required, first in the Module | The user ID on its own, so it can be printed for the hiring manager without the account's internal timing. Never the password. |
| `device.standard` | select (Standard, Non-standard), required, first in the Module | Whether the hardware is standard, as a choice rather than a phrase in the specification, so non-standard builds can be counted. |
| `device.build-notes` | markdown, optional | Request and ready dates and any overrun. Build timing moves out of `specification`, which the hiring manager reads. |

Changed and removed:

- **`handover.readiness-confirmation` is removed.** Readiness is the ready-to-start sign-off
  itself, and the Field only restated it. `handover.day-one` stays required but no longer asks
  who confirmed readiness, which **overturns v1's "who confirmed" readiness**.
- **`access.outstanding` is retitled "Not in place by the start date".** Its guidance now covers
  the device and the identity as well as entitlements, so it is the one early warning for
  anything missing.
- **Narrower guidance** for `identity.account` (when and where, not the user ID),
  `device.specification` (what was specified, no timing) and `device.non-standard-decision` (who
  decided and what changed, not how long it took). `identity.credential-issue` records the
  channel, sender and date, never the password or the address.
- **`role.summary` and `role.team` are required at approved-to-recruit** rather than at every
  Gate, so Starter Readiness can reference them `?` without them counting at ready-to-start.
  The bare references at the other Gates are unchanged.

The Hire Record gains `identity.user-id` and `device.standard` bare and `device.build-notes?`,
and prints them. At ready-to-start, Starter Readiness and the Hire Record now owe the same 11
Provisioning Fields, and the Gate's bar is 13: those 11 plus the candidate name and start date
that name the documents. v2's bar was also 13. The worked hire is migrated: its user ID and
device choice are in their own Fields, and the build timing is in the build notes.

### Correction to v2 (E5)

v2's changelog says `selection.candidate-name?` in the `requires` of `offer-pack`,
`starter-readiness` and `manager-handover` "keeps it from changing either artefact's own
gate-completeness bar". That is false. The `?` only exempts a field that isn't otherwise required
at the gate, and `candidate-name` is `required: true`, so it gated all three documents all along.
v2 is immutable, so the correction is recorded here rather than there.

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
