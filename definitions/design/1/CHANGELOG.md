## v1

Initial published version of the Solution Design definition.

### Title reconciliation (WI #268, in place — see docs/adr/0027)

Module and field `title:` values reconciled to the wording of the reference
SOAP, Full SOAP and HLD templates. All `id:` values unchanged; rendered
artefact output is unchanged except for the two intended `soap` heading
renames noted below.

- `context` module: `Context` → `Background and context`
- `context.driver`: `Business driver` → `Problem statement`
- `context.in-scope`: `In scope` → `In Scope`
- `context.out-of-scope`: `Explicitly out of scope` → `Out of Scope`
- `solution-definition.high-level-requirements`: `High-level requirements` → `High Level Requirements`
- `solution-definition.high-level-solution-design`: `High-level solution design` → `High level solution overview`
- `solution-definition.assumptions-and-considerations`: `Assumptions and considerations` → `Assumptions`
- `team-and-estimates` module: `Team and Estimates` → `Teams, contact persons, and high-level estimates`
- `team-and-estimates.teams-and-contacts`: `Teams and contact persons` → `Teams required`
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
