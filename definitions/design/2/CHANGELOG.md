## v2

Layout revision of v1. Every artefact's `requires` list re-sequenced to the reading
order of its reference document; reuse wired up where v1 declared it but never
connected it; two duplicate field pairs merged. No field `id` renamed. The
rest of this file gives the heading-by-heading mapping behind each move.

### Round four: the HLD trimmed to the TAC reference template's sections (WI #362)

The `hld` artefact listed **38** field references. The *2026 TAC Architecture High
Level Solution Design Template* has a cover block plus 19 headed body sections,
one concept each, and the WI #266 reconciliation concluded "no new fields needed,
no fields to remove". The count roughly doubled for three reasons — whole modules
expanded to every one of their fields when `requires` went field-level (`nfrs`,
`security`, `risks`, `dependencies`); backbone fields wired in for cross-document
reuse (`design-basis.*`, `background.affected-domains`,
`solution-definition.high-level-solution-overview`); and build-ready concerns
surfaced early (`dependencies.dependency-list`, three more `nfrs` fields).
Because the web editor filters visible fields by the selected artefact's
`requires`, the HLD form, the gate and the rendered document inflated together.

`hld.requires` is now **24 entries — one per reference section**, in render order,
using the field ids as consolidated since that template was written
(`problem-statement` → `background`; scope → `introduction.in-scope` /
`.out-of-scope`; questions → the shared `open-questions`).

- **14 field references dropped from the HLD** (38 → 24; the WI #362 ticket says
  "16", but its own list — reproduced here — names 14, and 38 − 24 = 14):
  `background.affected-domains`;
  `design-basis.assumptions?`, `design-basis.constraints?`,
  `design-basis.caveats?`; `solution-definition.high-level-solution-overview?`;
  `nfrs.scalability-and-capacity?`, `nfrs.disaster-recovery-and-backup?`,
  `nfrs.other-nfrs?`, `nfrs.requirements-traceability?`;
  `dependencies.dependency-list?`; `risks.open-issues?`;
  `security.security-architecture?`, `security.identity-and-access?`,
  `security.regulations-and-standards?`.
- **Design basis is removed from the HLD**, reversing WI #331's "every artefact"
  placement for this one document. The TAC template has no home for assumptions,
  constraints or caveats, and for a paper written to be read by TAC, fidelity to
  the reference outweighs cross-document consistency. The `# Design basis`
  section still renders in the Full SOAP, the SAD and the As-built, and the
  fields are still authored at Shape, Detailed Design and Handover. See
  `docs/adr/0032-hld-follows-the-tac-reference-template.md`.
- **Template**: `templates/hld.md.tmpl` drops `## Affected domains`, the whole
  `# Design basis` block, `## Solution overview`, `## Dependency list` and
  `## Open issues`. `## Non-functional requirements` and `## Security and
  privacy` collapse back to a single `##` heading each — the v1 layout —
  carrying `nfrs.performance` + `nfrs.availability-and-continuity` and
  `security.privacy-and-confidentiality` respectively.
- **Stage mounts**: `hld-define` drops `design-basis` and `solution-definition`
  from its `modules:` list. The trimmed artefact requires no field from either
  and `hld` is the stage's only artefact, so mounting them would put editor cards
  on the HLD screen that no HLD section renders. Both still mount at `shape` and
  `detailed-design`.
- **Kept gantry-only additions** (endorsed by WI #266): the headed `# Submission`
  block, `proposed-solution.guardrails` as the Proposed solution intro paragraph,
  and Attachments rendered last.
- **Gate**: no gate was loosened or tightened for the two fixture instances —
  `gantry` still fails `hld-tac-approved` and `kiwi-cover-mutual` still passes.
  At the field level, 12 of the 14 dropped references did not gate at
  `hld-tac-approved` at all. Two did: `background.affected-domains` (bare,
  `required: true`) and `solution-definition.high-level-solution-overview`
  (`required: true`, so its `?` suffix did not exempt it). Both remain mandatory
  at `business-case`, which every HLD is downstream of, and
  `high-level-solution-overview` was only ever demanded at this gate from v2
  onwards — so for that field this restores v1 behaviour. The three fields the
  reference does mandate — `nfrs.performance`,
  `nfrs.availability-and-continuity`, `security.privacy-and-confidentiality` —
  stay bare and keep their `required-at: hld-tac-approved`.
- **No data is lost.** Every dropped field lives in a shared module that still
  mounts at Shape or Detailed Design, so anything already written stays on disk
  and reappears at the stage that owns it.

### Round three: `introduction` split into "Overview" + "Design Basis" (WI #331)

`introduction.yaml`'s eleven fields spanned two functionally different
clusters sharing one module, one heading ("Introduction"), and one editor
mount position per stage: document-opening framing content (executive
summary, overview, purpose, in/out-of-scope, content standards) and ongoing
design conditions (constraints, assumptions, caveats, design principles,
outcomes/deliverables). The editor mount position was inconsistent across
stages (near the end at SOAP/HLD, mid-list at Detailed Design, near the
front at Handover), and the two clusters rendered inconsistently relative to
each other across artefacts — bundled together near the top in SAD/As-built,
but split apart in Full SOAP and HLD, where the conditions cluster was pushed
to just before References/Attachments.

- **`introduction` retitled "Overview"** (id unchanged — no data migration for
  these fields). Field set narrowed to the framing cluster:
  `executive-summary`, `overview`, `purpose`, `in-scope`, `out-of-scope`,
  `content-standards`.
- **New module `design-basis`** (title "Design Basis") holds the conditions
  cluster: `constraints`, `assumptions`, `caveats`, `design-principles`,
  `outcomes-and-deliverables`. Each field's own `id`, `type`, `required-at`
  and `guidance` is unchanged — only its owning module changed. ADR-0028's
  "entered once, refined at every later stage" reasoning for
  constraints/assumptions/caveats still applies, per module.
- **Stage mounts**: both modules mount at the same four stages `introduction`
  always did (`shape`, `hld-define`, `detailed-design`, `handover`), as an
  adjacent pair, near the front — immediately after the stage's own
  context-setting module (`background`, where one exists), ahead of
  solution-detail modules. `shape` and `hld-define` move the pair from
  6th-7th/10th-11th to 2nd-3rd/3rd-4th; `detailed-design` (no context module
  of its own) moves it from 10th to 1st-2nd, matching the SAD's own document
  layout; `handover` keeps `introduction`'s existing 2nd position and adds
  `design-basis` adjacent at 3rd.
- **Document position**: "Overview" and "Design Basis" render as adjacent
  headings, in that order, near the front of every artefact that carries them.
  `soap-full` and `hld` move the conditions cluster from just before
  References/Attachments (end of document) into a new "Design basis" section
  right after Out of scope / Problem Statement — a deliberate deviation from
  the JEDI/TAC reference documents' own literal section order, accepted
  because cross-document consistency for this backbone module outweighs
  fidelity to one legacy reference's placement of "Assumptions". `sad` and
  `as-built` split their existing single "Introduction" heading into
  "Overview" + "Design basis", both still adjacent and in the same position.
  `ssad` folds `executive-summary` (previously its own standalone 1st-section
  heading) into the same "Overview" block as purpose/scope/content-standards,
  still 4th overall; `ssad` renders no `design-basis` fields, so nothing else
  changes there. `soap` is unchanged — it renders no standalone heading for
  either module; `design-basis.assumptions` still folds into "Assumptions and
  considerations" mid-document.
- **Cross-references updated**: `architecture.constraints`'s guidance and
  `soap-full-details.caveats`'s guidance (both cross-reference a moved field)
  now point at `design-basis.*` instead of `introduction.*`.
- **Fixture instances updated**: `examples` and `atlas-reference-design`'s
  stored `modules/introduction.md` content split into `modules/introduction.md`
  (framing fields) and a new `modules/design-basis.md` (conditions fields) to
  match the new module structure. Live/end-user instance data migration is out
  of scope for this change (still pre-release).

### Round two: open questions closed

- **`introduction.executive-summary` added** (optional), wired into `sad` and `ssad`.
  The SAD and SSAD references both open with an Executive Summary that had no
  field. Kept separate from `introduction.overview`, which the SAD also carries.
- **`architecture.solution-users` added** (optional, list). The SAD's "Solution
  Users" (§5.2.1) asks for a User / Description table of the roles that use the
  system; no field carried it.
- **`integration.software-and-licences` added** (optional). The SAD's
  "Application Software View" (§13.1) asks for software, version, total count and
  licences per environment; no field carried it.
- **`support-and-operations.decommission` added** (optional), and decommissioning
  removed from `nfrs.other-nfrs` guidance. End of life is an operational
  lifecycle commitment, not a quality attribute.
- **`support-and-operations.operational-security-controls` removed.** Security
  had three homes for the same content at the same gate. The SSAD's own security
  sections ("developer access to the repositories is restricted to Somar staff
  only"; "API access to Healthpoint is handled by the ingest API and is the only
  component that calls it") are Access-management and Networking rows in the
  approved ATLAS design's control register. `ssad.requires` now lists
  `data-security-controls.controls` (bare, as the removed field was) and
  `.inheritance-and-dependencies?`. Security is now two modules layered by stage:
  `security` for the design-time posture, `data-security-controls` for the
  control set.
- **Disaster recovery split by role, targets pulled through to handover.**
  `nfrs.disaster-recovery-and-backup` owns RTO/RPO and the backup policy
  outright; `recovery-plan.recovery-approach` no longer restates them and
  describes only the mechanism. `nfrs` is mounted at the `handover` stage,
  `disaster-recovery-and-backup` declares `operational-handover`, and the
  `as-built` artefact renders it immediately before the recovery plan.
- **Scope removed from the lightweight SOAP.** `introduction.in-scope` /
  `.out-of-scope` are out of `soap.requires` and `business-case` is out of their
  `required-at`. The reference SOAP has no scope section. The Full SOAP still
  lists both bare, so producing one still forces scope at that gate. This is the
  one deliberate gate loosening in v2.
- **Confirmed as decisions, no change:** `background.problem` and
  `architecture.business-context` stay separate (TAC decision vs builder
  setting); `soap-full-details.caveats` and `introduction.caveats` stay separate
  (verified: the reference Full SOAP's eight caveats all qualify the estimate,
  while the ATLAS design's caveat states a fact about the solution); "Hosting &
  Sites" stays folded into `integration.network-and-infrastructure`.
- **Deliberately not modelled:** the SAD's Document Control, Approved By,
  Consulted, Distribution, Tables & Figures and Appendix, and the SSAD's Sign-Off.
  These stay with the tool and the repo.

### Sequencing

- **`hld`** moved from a whole-module `requires` to a field-level one so the TAC
  template's nesting can be expressed: scope and NFRs inside Problem Statement;
  dependencies, risks and security inside Proposed solution; `attachments` last
  instead of first. Editor scope preserved (every field of the former
  whole-module entries is listed, `?` where it was not mandatory).
- **`sad`**: `dependencies` moved early (reference §6); `risks.open-issues` to
  its own position after the architectural view (§8); `recovery-plan` +
  `nfrs.disaster-recovery-and-backup` before the Information View (§14); the
  `nfrs` performance/scalability/availability fields late, into Operating
  Considerations (§17). `architecture` and `data` field order re-sequenced to
  §7 and §15.
- **`ssad`**: `architecture.logical-components` and `.architectural-risks` moved
  to the front (the reference opens with Solution Products and puts
  Architectural Risks before the Introduction); `release-procedures` moved late.
- **`as-built`**: the governance fields (`changes-from-design`,
  `acceptance-criteria`, `operational-notes`, `handover-confirmation`) moved to
  the end, after the Appendix — v1's order contradicted its own comment.
- **`soap`**: `high-level-requirements` moved ahead of `process-flow`.
- Module field order re-sequenced in `architecture`, `data`, `hld-submission`,
  `integration`, `nfrs`, `proposed-solution`, `support-and-operations`.

### Merges (two field ids removed)

- **`soap-full-details.questions` → `open-questions.questions`.** Same concept as
  the HLD's "Open questions". `open-questions` is now mounted from `shape`;
  `soap-full` references it bare, so the `business-case` gate is unchanged.
- **`integration.environments` → `support-and-operations.environments-and-domains`.**
  The SAD's "Environments" and the SSAD's "Solution Domains" / "URL's, Domains and
  redirections" are one list. `sad` references the shared field bare; gate unchanged.

### Regression fixed

- **`introduction.assumptions?` restored to `soap`.** The reference SOAP carries an
  "Assumptions and considerations" section. WI #280 deleted
  `solution-definition.assumptions-and-considerations` and wired
  `introduction.assumptions` into `soap-full` and `hld` but not `soap`, so the
  lightweight SOAP had no home for it.

### Gate changes

- `nfrs.performance`, `nfrs.availability-and-continuity` and
  `security.privacy-and-confidentiality` now also `required-at: hld-tac-approved`.
  The TAC template makes its "Non-functional requirements" and "Security and
  privacy" sections mandatory ("do not delete sections"), but every field in both
  modules was `build-ready-checklist`-only, so the HLD gate enforced neither.
  Only the fields the template names directly are mandated.
- `introduction.in-scope` / `.out-of-scope` now declare
  `required-at: [business-case, hld-tac-approved, build-ready-checklist,
  operational-handover]` — truthfulness only, matching the bare field references
  that already forced them at the first two gates. No behaviour change.

### Reuse wired up (all optional, no gate change)

`introduction.overview` → `soap-full`; `solution-definition.high-level-solution-overview`
→ `hld`; `solution-definition.high-level-requirements` / `.process-flow`,
`support-and-operations.stakeholders` / `.operational-accounts-and-licenses` /
`.monitoring-and-alerting`, `integration.hardware` / `.bandwidth` /
`.network-devices` / `.communication-and-network-protocols` / `.san`,
`recovery-plan.resiliency` / `.test-scenarios` / `.raci`,
`data-security-controls.inheritance-and-dependencies` and
`team-and-estimates.references` → `sad`; `team-and-estimates.references` and
`introduction.content-standards` → `ssad`; `introduction.design-principles` /
`.outcomes-and-deliverables` → `as-built`. The five `integration` deployment
fields had existed since WI #227 with **no artefact rendering them at all**.

Stage mounts added: `solution-definition` at `hld-define`; `solution-definition`
and `team-and-estimates` at `detailed-design`; `open-questions` at `shape`.

### Correction

v1's `definition.yaml` claimed `SAD Template.docx` carries "a trailing Glossary".
It does not — the document has no Glossary or Terms & Definitions section.
`glossary.terms-and-definitions` is retained in `sad` on its merits (the SSAD and
as-built references both carry one), but the stated justification was wrong.

## v1

Initial published version of the Solution Design definition.

### Cross-stage reuse: `background` + `introduction` backbone (WI #280, in place — see docs/adr/0028)

A structural change to reduce SOAP↔HLD duplication and give scope and
assumptions a single home that carries from SOAP to handover. Applied to
`definitions/design/1/` in place (no `design/2`), with the `examples` and
`atlas-reference-design` fixtures migrated in lockstep. Every gate still
passes; `render:examples` loses no author content (headings move/rename and
scope splits into two sub-sections).

- **`context` module renamed to `background`** (`modules/context.yaml` →
  `modules/background.yaml`). `problem-statement` merged in and deleted.
  Final fields: `problem` (current state; from `context.driver` +
  `problem-statement.current-state`; required-at business-case + HLD),
  `affected-domains` (unchanged), `opportunity` (desired future state; from
  `context.opportunity` + `problem-statement.desired-future-state`;
  required-at HLD), `success-criteria` (from `problem-statement`; required-at
  HLD).
- **Scope backbone.** `introduction.scope` split into `introduction.in-scope`
  and `introduction.out-of-scope` (markdown). `introduction` is now mounted
  from the `shape` stage onward; the two scope fields are the canonical
  cross-stage scope statement, wired into `soap` / `soap-full` / `hld` /
  `sad` / `ssad` / `as-built` `requires`. `context.in-scope` /
  `context.out-of-scope` and `problem-statement.scope` are gone.
- **Assumptions backbone.** `solution-definition.assumptions-and-considerations`
  deleted; `introduction.assumptions` / `.constraints` / `.caveats` now carry
  from SOAP onward and are scoped into `soap-full` / `hld` (`?` optional).
  `architecture.constraints-and-assumptions` renamed to
  `architecture.constraints` ("Constraints and goals"), for
  architecture-specific constraints/goals only.
- **SOAP traceability.** `solution-definition.high-level-requirements` is now
  `required: true` and rendered by `soap.md.tmpl` (it is the agreed set
  `nfrs.requirements-traceability` maps back to). New optional
  `solution-definition.alternatives-sketch` seeds `alternatives-considered`
  for TAC.
- **`required-at` truthfulness.** `introduction.overview` / `.purpose` /
  `.in-scope` / `.out-of-scope`, `recovery-plan.recovery-approach` and
  `data-security-controls.controls` now declare
  `required-at: [build-ready-checklist, operational-handover]`, matching the
  `sad` artefact's field-level `requires` (no gate-behaviour change).
- **Guidance cross-references** added across `proposed-solution`,
  `architecture`, `solution-definition`, `nfrs`, `security`, `open-questions`
  and a reciprocal "HLD `background` vs SAD `introduction` framings are
  intentionally separate" note on `background.problem` and
  `introduction.overview`.
- Templates `soap` / `soap-full` / `hld` / `sad` / `ssad` / `as-built`
  updated for every moved/renamed/split/deleted field.

### `soap` artefact trimmed to a field-level `requires` list (WI #276, in place — see docs/adr/0027)

Now that the engine supports an optional field-ref suffix (`module.field?` —
a field that is in the artefact's scope but only blocks the gate when its own
`required` / `required-at` makes it mandatory), `soap.requires` moves from the
whole-module list `[context, solution-definition, team-and-estimates]` to the
exact fields `soap.md.tmpl` renders, in template section order:

```
context.driver, context.affected-domains, context.out-of-scope?,
solution-definition.process-flow, solution-definition.high-level-solution-overview,
solution-definition.assumptions-and-considerations?, solution-definition.feature-breakdown,
team-and-estimates.teams-required, team-and-estimates.estimates, team-and-estimates.references?
```

- The three never-rendered fields (`context.opportunity`, `context.in-scope`,
  `solution-definition.high-level-requirements`) are dropped — they are Full
  SOAP concepts.
- The three conditionally-rendered fields (`context.out-of-scope`,
  `solution-definition.assumptions-and-considerations`,
  `team-and-estimates.references` — all `required: false`) carry `?`, so the
  `business-case` gate is exactly as strict as under the whole-module list.
- `soap-full` is unchanged (its own `requires` list is independent).
- No instance data migration; rendered SOAP output is byte-identical. Both
  fixtures still pass `check --gate business-case`.

### Field id / title reconciliation round 2 (WI #274, in place — see docs/adr/0027)

**Part 1 — id contradictions.** Two field `id:` values renamed so the id no
longer contradicts its title. Ids are referenced by `id` from the templates
and the `soap-full` artefact's `module.field` `requires` list; those
references and every fixture/test reference were updated in lockstep. No
instance data migration (instance module files match sections by title, and
the titles are unchanged).

- `solution-definition`: the "High level solution overview" field's id is
  now `high-level-solution-overview` — previously a `…-solution-design`
  slug that contradicted the title.
- `team-and-estimates`: the "Teams required" field's id is now
  `teams-required` — previously a `teams-and-contact…` slug that
  contradicted the title.

**Part 2 — casing / wording nits** (display titles only; ids unchanged):

- `context.in-scope`: `In Scope` → `In scope`
- `context.out-of-scope`: `Out of Scope` → `Out of scope`
- `solution-definition.high-level-requirements`: `High Level Requirements` →
  `High-level requirements`
- `alternatives-considered` module: `Alternatives Considered` →
  `Alternatives considered`
- `soap-full.md.tmpl`: the hand-rolled `## Metadata` table heading was
  dropped (finding F12/F13 in
  docs/reconciliation/template-consistency.md) so the five metadata fields
  open the document as a bare table, like the rest of the template's
  sections.

Fixture instance module-file `##`/`#` headings for `examples` and
`atlas-reference-design` were updated to match the new titles.

**Part 3 — drop 3 dead `soap` fields: not implemented in WI #274; applied
later by WI #276** (see the section at the top of this file). The SOAP report's
recommendation to scope the `soap` artefact to a field-level `requires` list
(omitting the never-rendered `context.opportunity`, `context.in-scope`,
`solution-definition.high-level-requirements`) was **not applied**: gantry's
`requires` schema has no syntax to mark a field-level entry optional
(`lib/status.js` pushes every `module.field` entry into the gated set
regardless of the field's own `required:` flag; `splitArtefactRequirement`
is a plain string split). The list would therefore force
`context.out-of-scope`, `solution-definition.assumptions-and-considerations`
and `team-and-estimates.references` — currently optional — mandatory at the
`business-case` gate. `soap.requires` stays
`[context, solution-definition, team-and-estimates]`. See docs/adr/0027 for
the full findings.

### Title reconciliation (WI #268, in place — see docs/adr/0027)

Module and field `title:` values reconciled to the wording of the reference
SOAP, Full SOAP and HLD templates. All `id:` values unchanged; rendered
artefact output is unchanged except for the two intended `soap` heading
renames noted below.

- `context` module: `Context` → `Background and context`
- `context.driver`: `Business driver` → `Problem statement`
- `context.in-scope`: `In scope` → `In Scope` (reverted to `In scope` by WI #274)
- `context.out-of-scope`: `Explicitly out of scope` → `Out of Scope` (set to `Out of scope` by WI #274)
- `solution-definition.high-level-requirements`: `High-level requirements` → `High Level Requirements` (set to `High-level requirements` by WI #274)
- `solution-definition` "High level solution overview" field: `High-level solution design` → `High level solution overview` (field id renamed to match by WI #274)
- `solution-definition.assumptions-and-considerations`: `Assumptions and considerations` → `Assumptions`
- `team-and-estimates` module: `Team and Estimates` → `Teams, contact persons, and high-level estimates`
- `team-and-estimates` "Teams required" field: `Teams and contact persons` → `Teams required` (field id renamed to match by WI #274)
- `team-and-estimates.estimates`: `High-level estimates` → `Estimates`
- `dependencies.dependencies-overview`: `Dependencies overview` → `Dependencies`
- `problem-statement.scope`: `In and out of scope` → `In scope / out of scope`

`soap.md.tmpl` rendered headings updated to match: `# Context` →
`# Background and context`, `# Team and estimates` →
`# Teams, contact persons, and high-level estimates`.

The SOAP report's recommendation to drop the three dead fields
`context.opportunity`, `context.in-scope` and
`solution-definition.high-level-requirements` from the `soap` artefact is
**deferred to the design grill** — the in-place mechanism (a field-level
`requires`) would also narrow the lightweight-SOAP editor and tighten the
gate, neither of which is a title-only change. `soap` `requires` stays
`[context, solution-definition, team-and-estimates]` for now.

`soap-full-details.caveats` field added (defaulting to the JEDI Full SOAP
template's eight caveat bullets); `soap-full.md.tmpl` now renders that field
instead of hard-coding the bullets. `soap-full` artefact `requires` reordered
to follow the reference document's section order.
