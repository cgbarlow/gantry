# Gantry

A repo-driven pipeline for staged, gated processes: content is captured once
as modules, documents are rendered from that data on demand. See README.md
for the engine's own vocabulary (Definition, Stage, Gate, Module, Instance,
Artefact).

## Language

### The `design` definition

**Business Case Approved**:
The gate closing the Shape stage. Approves the SOAP (Solution on a Page).
_Avoid_: "business case gate" (use the full canonical name in artefacts and docs)

**HLD approved at Technical Architecture Committee (TAC)**:
The gate closing the HLD Definition stage. Approves the HLD (High Level
Design) paper submitted to TAC.
_Avoid_: "design authority gate" — Design Authority is a different, later
committee (see below); this gate belongs to TAC.

**Build Readiness Confirmed**:
The gate closing the Detailed Design stage. A single shared gate for both
the SAD and SSAD artefacts — they are two renderings of one module set, not
two independently-gated documents.
_Avoid_: "Design authority" as a name for this gate — that phrase was an
unresolved placeholder in the source coverage-assessment spreadsheet and has
since been superseded by this canonical name.

**Operational Handover completed and submitted to TAC for noting**:
The gate closing the Handover stage. Confirms the as-built/Detailed Design
documentation has been produced and handed to TAC for noting (not approval).

**ARB (Architecture Review Board)**:
The same governance body as TAC (Technical Architecture Committee) — not a
separate committee. Older source material (the SAD template) refers to "ARB
approval"; treat this as identical to TAC approval.
_Avoid_: treating ARB and TAC as two distinct bodies

**Design Authority**:
A governance committee distinct from ARB/TAC. Reviews the `sad`/`ssad`
artefacts (via the architecture-related modules) before the Build Readiness
Confirmed gate is reached. Not itself a gate — tracked via module frontmatter
`status`/`owner`, not a stage exit point.
_Avoid_: using "Design Authority" as a gate name — it is a review step, not a
gate. This role is a stated intent (Chris Barlow, 2026-08-17), not yet
corroborated by a charter or terms of reference.

**SOAP (Solution on a Page)**:
In this definition, specifically the Shape-stage artefact rendered from
`context`, `solution-definition` and `team-and-estimates` — modelled on the
real Confluence Epic SOAP structure. A *different* document, the TAC's own
"High Level Solution Design" template, is modelled separately as the `hld`
artefact — the two are not the same thing despite both sometimes being
called "SOAP" informally.
_Avoid_: using "SOAP" to mean the TAC HLD paper

**SAD (Solution Architecture Document) / SSAD (Solution Support Architecture Document)**:
Two artefacts rendered from the *same* module data (`architecture`,
`integration`, `data`, `nfrs`, `security`, `risks`, `dependencies`,
`support-and-operations`) at the Build Readiness Confirmed gate. SSAD is a
variation on SAD serving the same purpose (support-facing framing of the
same design), not a structurally distinct document requiring its own
module set.
_Avoid_: authoring SAD and SSAD content as if they were independent

**Module completeness by gate, not by authorship**:
`nfrs`, `risks`, `security` and `dependencies` are each a single module
required at two gates (`hld-tac-approved` and `build-ready-checklist`),
filled in progressively — not duplicated as separate lightweight/full
versions. Where a field's requiredness genuinely differs between the two
gates, that's expressed with the module-spec schema's `required-at` key
(see README.md "Field requiredness across shared gates"), not by splitting
the field or the module. Most `nfrs` and all `security` fields use
`required-at: [build-ready-checklist]`; `risks.risk-register` is required
at both gates as-is, since only its expected depth — not its
requiredness — changes; `dependencies` uses two distinct fields
(`dependencies-overview` required-at `hld-tac-approved`, `dependency-list`
required-at `build-ready-checklist`) since the overview genuinely isn't the
same shape of content as the full list, not two depths of one field.
_Avoid_: creating a second module (e.g. `nfrs-detailed`) for the later gate,
or treating `required-at` as a place to encode content depth rather than
requiredness. A 2026-08-18 audit found `dependencies` had been built as two
separate single-gate fields (`proposed-solution.dependencies` and
`integration.dependencies`) instead of this pattern — see
docs/adr/0003 — watch for other information categories built the same way
before assuming a new module/field pair is genuinely distinct content.

**Cost-benefit vs. NFR**:
Cost-benefit analysis lives in `proposed-solution` (HLD Definition stage),
not in `nfrs`. It's a one-off business justification for the HLD decision,
not a quality attribute the built solution must keep meeting.
_Avoid_: adding cost-benefit content to `nfrs` — that module is for
performance/availability/scalability-type requirements only

**Disaster recovery and backup vs. support-and-operations**:
RTO/RPO, backup schedule and retention live in the shared `nfrs` module
(`disaster-recovery-and-backup`), not in `support-and-operations` — it's a
quality attribute of the built solution, not a support-team-specific
concern, even though a 2026-08-18 gap review found it via a real SSAD
example.
_Avoid_: duplicating backup/retention content in `support-and-operations`

**Document history and sign-off**:
Revision history and formal sign-off for a module are tracked via the
instance module file's frontmatter `status`/`owner` convention and this
repo's git history — not a module field.
_Avoid_: adding a `sign-off` or `revision-history` field to any module
