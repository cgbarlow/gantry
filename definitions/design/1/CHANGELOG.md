## v1

Initial published version of the Solution Design definition.

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
