## v2

Layout revision of v1. Every artefact's `requires` list re-sequenced to the reading
order of its reference document; reuse wired up where v1 declared it but never
connected it; two duplicate field pairs merged. No field `id` renamed. The
rest of this file gives the heading-by-heading mapping behind each move.

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
