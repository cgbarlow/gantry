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

### Requisition and Selection (#154)

- **`engagement.approval-route` is removed.** The engagement type already fixes the route: Fixed
  term or Permanent takes the full approval chain, Vendor or Contractor the shortened one. The
  Requisition Brief and the Hire Record now print a derived "Standard approval route for this
  engagement type" line instead, so the route can't be re-entered wrongly or contradict the type.
  This overturns v1's "the one part that is genuinely content" (the v1 section below) and v2's
  option list for the field.
- **`engagement.route-variation` is added** (optional). A deliberate variation to the standard
  route, or a delegation within the chain, and who accepted it, recorded as to whom and never
  why. It is printed under the route line only when filled. The delegation sentence moves out of
  `engagement.rationale`'s guidance, and the worked hire's delegation moves with it.
- **The Requisition sign-off is the "Approved to Recruit" confirmation.** The Stage and Requisition
  Brief purposes now say so, and record the model's order: the approval chain decides first and
  role evaluation follows. Where the chain's decision is wanted before evaluation, an advisory
  review on the draft brief carries it.
- **The Requisition Brief** closes with "How the role was evaluated" (the method, still printed)
  after the outcome.
- **`vetting.checks-required` gains "Identity verification"**, which the worked hire had stored
  outside the list.
- **The Selection Report** always shows the Conditions heading for "Cleared with conditions",
  printing "— not stated —" when none is written, and warns when vetting reads Not cleared, since
  the gate can't restrict which option a select holds. The Hire Record's vetting conditions
  follow the same rule.
- **The term is shown for every non-permanent engagement** in the Requisition Brief and the Hire
  Record, printing "— not stated —" when blank, so a missing term is visible to the approver.
  These markers are deliberately not `na()`'s "— n/a —": the Field is optional, and the gap is
  still worth showing.
- **Reserve finalists.** `selection.unsuccessful` can be completed after Selection, once the offer
  is accepted and finalists held in reserve are released. The Selection stage purpose says not to
  sign off while vetting reads Not cleared.
- **Process gaps are written where they happen.** `open-questions.process-gaps?` is in the
  Requisition Brief's and the Selection Report's scope, so it can be written at those stages. It
  is still printed only in the Hire Record.
- **The Selection Report references `role.summary?`.** The summary belongs to Requisition, and
  it is required only at approved-to-recruit (#157), so it no longer gates candidate-selected.
- **Guidance:** the role Fields and `engagement.term` are also read by the new starter, so
  internal remarks are kept out, and the term gives an end date where there is one. The candidate
  name carries no other identifiers. Vetting conditions are named as the requirement to meet,
  with who accepted it and the date, never what a check returned.

The approved-to-recruit bar drops from v2's 9 bare Fields to 8, the candidate-selected bar from
10 to 9, and the Hire Record owes one Field fewer at ready-to-start.

### Carried-forward Fields required only at their home Gate, and read-only elsewhere (#159)

Later Stages no longer ask for earlier Stages' content, and no longer let it be edited.

- **Home gates.** Every carried-forward Field is now `required-at: [home gate]` instead of a
  blanket `required: true`: `role.*`, `engagement.type`/`rationale` and
  `role-evaluation.method`/`outcome` at `approved-to-recruit`; `advertising.channels`/`period`/
  `response` and `selection.shortlist`/`interviews`/`rationale` and
  `vetting.checks-required`/`outcome` at `candidate-selected`. `offer.terms` (`approved-to-appoint`)
  and `offer.status`/`contract.terms-summary`/`contract.manager-signed`/`contract.candidate-signed`/
  `payroll.details-requested`/`payroll.confirmed` (`onboarding-approved`) were already scoped this
  way by #155/#156/#158. `selection.candidate-name` and `contract.start-date` are the only two
  fields left as a blanket `required: true`, because the filename patterns need them wherever
  they're read.
  - **This fixes the Appointment Case's and the Onboarding Case's own bars.** `engagement.type` is
    in scope as `?` at both, but a blanket `required: true` made it gate there too. Their bars drop
    from 5 to 4 and from 9 to 8 respectively, matching the spec's gate-arithmetic table exactly:
    8 / 9 / 4 / 8 / 13.
  - This also stops `selection.shortlist`/`interviews`/`rationale` being marked required again at
    Offer, Contract and Payroll, where `selection` stays mounted and editable (so reserve
    finalists can be recorded in `selection.unsuccessful`) but its earlier-stage content shouldn't
    be re-asked for.
- **`read-only-modules` added to every Stage that carries earlier content**, per the spec's Stage
  table: Selection (`role`), Appointment (`role`, `engagement`, `selection`, `vetting`), Offer,
  Contract and Payroll (`role`, `engagement`), and Provisioning (every earlier Module:  `role`,
  `engagement`, `role-evaluation`, `advertising`, `selection`, `vetting`, `offer`, `contract`,
  `payroll`). `open-questions` is never read-only, and `selection` stays editable at Offer,
  Contract and Payroll. In the instance editor a read-only Module's Fields show read-only and never
  required; a write to one is refused, naming the Stage that owns it — the route MCP's
  `update_instance_modules` shares.
- **Stage purposes now say so.** Selection, Appointment, Offer, Contract and Payroll and
  Provisioning each state that their carried Modules are read-only and name reopening the owning
  Stage as how to change them.
- **The `open-questions` purpose is restated:** `questions` is in scope of every internal document
  and never the candidate's own; `process-gaps` can be written at the Stage where the gap happens
  and is printed only in the Hire Record.

### Correction to v2 (E5)

v2's changelog says `selection.candidate-name?` in the `requires` of `offer-pack`,
`starter-readiness` and `manager-handover` "keeps it from changing either artefact's own
gate-completeness bar". That is false. The `?` only exempts a field that isn't otherwise required
at the gate, and `candidate-name` is `required: true`, so it gated all three documents all along.
v2 is immutable, so the correction is recorded here rather than there.

### Appointment split into the executive approval and Offer, Contract and Payroll (#155)

The source model has Executive Approval before any offer is made and Onboarding Approved after
payroll validates, but v2's single Appointment stage could only gate on the later one: nothing
could be signed off until the contract was signed and payroll validated. v3 has five stages:

| Stage | Gate | Owner |
|---|---|---|
| Requisition | `approved-to-recruit` | The requesting department |
| Selection | `candidate-selected` | HR |
| Appointment | `approved-to-appoint` (new) | The requesting department |
| Offer, Contract and Payroll | `onboarding-approved` | HR, with Payroll validating |
| Provisioning | `ready-to-start` | Technology |

This overturns v1's **"Four stages, not the source model's three phases"**. The reasoning that
split Phase 1 at "Approved to Recruit" (one gate per stage means a stage holding two approvals
can only gate on the later one) applies equally to Phase 2, so Phase 2 is split at Executive
Approval. The stage id is `offer-contract-payroll` rather than `onboarding` because the source
model's glossary uses "Onboarding" for Phases 2 and 3 together.

- **Appointment Case** moves to `approved-to-appoint` and becomes the case put to executive
  approval before any offer: the candidate name, selection rationale, vetting outcome and the
  proposed offer terms are bare (4 fields); role, team, engagement type and term, and vetting
  conditions are in scope as `?`. It prints a term heading for any non-permanent engagement and a
  Vetting conditions heading for "Cleared with conditions", each reading "— not stated —" when
  blank, so the approver can see what is missing. The offer outcome, contract and payroll are no
  longer in it.
- **Onboarding Case** (new, internal) is the record put to whoever approves onboarding: the offer
  terms as extended, the status (with a warning when it isn't Accepted) and negotiation, the
  contract terms, variations and signature dates, the start date and its changes, and Payroll's
  requests, rework and confirmation. Its 8 bare fields are the candidate name, offer status,
  contract terms, both signature dates, start date, details requested and payroll confirmation.
  `selection.unsuccessful`, `contract.elapsed`, `payroll.validation-outcome` and process gaps are
  in its `requires` so they can be written at this stage, but it doesn't print them.
- **`selection`** stays mounted at Offer, Contract and Payroll, so finalists held in reserve can
  be recorded as released once the offer is accepted.
- **The Offer Pack** stays at `onboarding-approved` as v2 had it, changed only for the field
  changes below, until the Appointment Confirmation replaces it. Until then it can still satisfy
  the gate on its own, at a higher bar than the Onboarding Case.
- **The Hire Record** prints the two signature dates in place of the signatures, the contract's
  variations from the offer when there are any, and the payroll validation outcome only when it
  is filled.

### Offer, contract and payroll fields (#155)

- **`contract.signatures` is replaced** by `contract.manager-signed` and
  `contract.candidate-signed`, both dates, so the gap between them can be measured rather than
  described. Any comment on timing belongs in `elapsed`.
- **`contract.variations`** (new, optional) records how the agreement as drawn differs from the
  accepted offer, separately from `terms-summary`, so the summary can be shown to the starter.
- **`payroll.validation-outcome` is now `required: false`.** Only Passed can reach onboarding
  approval, because a failure loops back to the details request, so as a gating field it could
  only ever restate `payroll.confirmed`. It stays for the permanent record.
- **Home gates.** `offer.terms` is required at `approved-to-appoint`; `offer.status`,
  `contract.terms-summary`, both signature dates, `payroll.details-requested` and
  `payroll.confirmed` are required at `onboarding-approved`.

Guidance rewritten:

- `offer.terms` is written at Appointment, extended unchanged, and not edited afterwards; every
  later change goes in `negotiation`. A decline is recorded with a reason category, not the
  candidate's personal reasons.
- `offer.terms` and `contract.terms-summary` give remuneration as the band and position in band,
  never the salary figure.
- The contract module never has the executed contract, or an image of it, attached: it carries
  the starter's personal details and instance content is committed to git.
- `payroll.details-requested` is one line per send, date and channel only; why a send was
  repeated belongs in `rework`, recorded as a cause category and the delay.
- `payroll.confirmed` does not record onboarding approval: that is the sign-off on the stage.
- `contract.elapsed` is measured to the agreed start date and filled before onboarding approval.

### Manager Handover for the hiring manager (#158)

The Manager Handover becomes a document the hiring manager can act on, and stops counting toward
the gate — the first of v3's two audience documents (`document-control: false` and
`satisfies-gate: false`); the Appointment Confirmation is the other.

- **`requires` is now exactly what it prints, plus the filename tokens.** Gone from it:
  `role.team`, `identity.account`, `identity.propagation`, `identity.credential-issue` and
  `access.setup` — all Technology's own record, which Starter Readiness and the Hire Record still
  carry in full. `identity.user-id` is added: the one Technology field the manager does need, to
  pass on to the starter.
- **A derived headline** opens the document: "Everything is in place for the start date." when
  the device reads Ready and nothing is listed as not in place by the start date, otherwise "Some
  items are not yet in place. See below." — so the manager doesn't have to read the whole document
  to know which applies.
- **Gone from the rendered document:** the reporting line (the manager wrote it), the account and
  propagation detail, the credential-issue history, access setup, open questions, and, with every
  v3 audience document, the Document Control and Review & sign-off tables.
- **The credential step now appears once, as the manager's own action.**
  `handover.manager-actions`'s guidance now asks for issuing the credentials as a dated action, for
  any open question the hiring manager personally owes an answer to, and it now allows an action
  already done by sign-off to be stated as done with its date — so the document can no longer say
  the credentials were sent while also listing sending them as something still to do.
- **Provisioning's purpose** now says to render the handover and send it to the hiring manager as
  soon as the account exists, then re-send it at sign-off.

This overturns v1's rule that every artefact at a gate shares the same core field set (see "The
gates are strict" in the v1 section below), for this document: it no longer shares a bare set
with Starter Readiness at all, now that it opts out of satisfying the gate. The harness proves it
can't: completing the Manager Handover alone on a blank instance never passes ready-to-start.

### The Appointment Confirmation replaces the Offer Pack (#156)

The Offer Pack printed the case for hiring, not the outcome of it: the offer terms and status
that HR and the candidate had already agreed and moved past, the two signature dates without
what either party had actually confirmed, and the raw payroll validation outcome rather than a
plain statement that it was done. None of it is what a starter needs on their way in. It is
removed from v3 and replaced by the **Appointment Confirmation**, at the same `onboarding-approved`
gate.

- **It opts out of both new switches.** `document-control: false`, so it carries no Document
  Control or Review & sign-off table — only the H1 and the content below it. `satisfies-gate:
  false`, so it is rendered and linked in the approval request once complete, exactly as before,
  but completing it alone can never pass onboarding-approved; only the Onboarding Case can.
  `requires` is exactly what it prints, plus the two filename tokens — no field is carried just
  to hold the gate open.
- **What it prints, in order:** an opening line addressed to the candidate by name; their role
  (summary, team, responsibilities, engagement type, and the term or expected duration, shown
  only when one is filled — never an internal "— not stated —" marker in a document a candidate
  reads); their terms (start date, the terms summary, and a fixed sentence that the signed
  agreement takes precedence over this summary); a further fixed sentence that payroll details
  have been received and validated, shown once `payroll.confirmed` is filled, naming no one and
  carrying none of Payroll's back-office history; and a closing fixed paragraph on what happens
  next, pointing back to the manager named under Team and reporting line.
- **What it drops from the Offer Pack:** the offer terms and status, both signature dates,
  start-date changes, the raw payroll validation outcome, Payroll's request and rework history,
  and open questions. None of it is the candidate's business, and printing any of it was the
  root problem this ticket exists to fix.
- **This overturns v1's "same core field set" for the two audience Artefacts at a shared Gate**
  (the v1 section below, "The gates are strict"): the Appointment Confirmation and the Onboarding
  Case no longer owe the same bare Fields at onboarding-approved, because the Appointment
  Confirmation no longer counts toward the gate at all. It also **overturns v2's "never as a
  rendered section" for `selection.candidate-name`** in this document (the v2 section below,
  "Filename patterns"): the candidate's own name is now the printed addressee ("For {name}"),
  not just a token reached through `requires` to build the filename.
- The worked hire needed no field migration for this change — the Offer Pack and the Appointment
  Confirmation read the same Fields the fixture already carried; only the rendered document and
  its place in the Gate arithmetic changed.

### Hire Record process order, guidance sweep and final verification (#160)

v3's last ticket: the Hire Record's outline catches up with the Appointment split (#155), the
spec's remaining guidance rewrites are swept in, and the harness proves the whole draft.

- **The Hire Record now has five sections, one per Stage**, matching the Appointment split: it
  used to hold Offer, Contract and Payroll content under a stale "# Appointment" heading left over
  from v1/v2's four-stage process. "# Appointment" now carries only what is actually authored at
  that Stage — "Offer terms as approved" — and a new "# Offer, Contract and Payroll" heading opens
  before Offer status, so the record reads in true process order: Requisition, Selection,
  Appointment, Offer, Contract and Payroll, Provisioning.
- **The closing section is retitled "Questions still open at sign-off"**, in place of "Open
  questions and process gaps", so the record's own final word matches the spec's outline.
- **The Hire Record's purpose now says it is the record as at readiness sign-off**, and to request
  Provisioning's approval only once it is complete, confirming with `gantry check --json` or
  `check_gate` first. Provisioning's own purpose says the same about requesting its approval.
- **Guidance rewrites already carried by #154/#155/#158** — band not figure, never attach the
  executed contract, vetting conditions as the requirement to meet, credentials as channel/sender/
  date, the candidate name with no other identifiers, decline and rework reason categories, and a
  delegation recorded as to whom rather than why — are confirmed present; the one still missing,
  the `open-questions` purpose restatement, is added by #159 above.
- **The harness now asserts the full gate-arithmetic table directly**: 8 / 9 / 4 / 8 / 13,
  read from the same `GATES` table every ticket has extended, plus the read-only-modules table,
  the two carried-Field checks, and the write-refusal each #159 change needed proving.
- **Verification for this round:** `findDefinitionProblems` and the Local Workspace twin both
  report zero problems for v3; all 8 Artefacts render against the worked hire; every Gate passes
  at its spec bar; `definitions/recruitment-onboarding/2` is untouched (`git diff` is empty); no
  v3 Gate is lower than v2's own bar except where a recommendation deliberately changed it
  (`approved-to-recruit` 9→8, `candidate-selected` 10→9, both named above).
- **Out of scope, as the ticket says:** publishing v3 and migrating the platform-engineer worked
  example to it remain the process owner's step, unchanged from every earlier v3 ticket.

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
