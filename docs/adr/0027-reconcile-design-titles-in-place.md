# Reconcile SOAP / Full-SOAP / HLD titles in `design/1` in place

WI #268. The Phase 1/2 reconciliation reports (`docs/reconciliation/soap-reconciliation.md`, `soap-full-reconciliation.md`, `hld-reconciliation.md`) found ~12 module and field `title:` values in the `design` definition whose wording does not match the reference SOAP, Full SOAP and HLD templates those artefacts are meant to reproduce. The rendered `.docx` output already matches the reference documents (the templates hard-code their headings); the drift is entirely in the module-editor labels an architect sees while authoring, plus three dead `soap` fields and a `soap-full` `requires` order that does not follow the reference's section order.

## Decision

Apply the reports' recommendations by editing **`definitions/design/1/` in place** — the already-published version — rather than cutting a `design/2`.

Rationale:

- **Display-title only.** Every field and module `id:` stays the same. Templates read module data by `id`, so rendered artefact output is unchanged except for the two `soap` headings the reports explicitly ask to rename in the output (`Context` → `Background and context`, `Team and estimates` → `Teams, contact persons, and high-level estimates`).
- **No instance data migration.** No field is added to or removed from any instance's stored values; no `id` moves. The in-repo fixture instances (`examples`, `atlas-reference-design`) have their module-file `##`/`#` headings updated in lockstep because the instance parser matches sections to fields by `title` — but that is a mechanical heading-text edit, not a data migration, and live instances pick up the new editor labels immediately on next load (their next save rewrites the module file headings to the new titles automatically).
- **Reversible and low risk.** A `design/2` would force every existing instance onto a new definition version for what is a label correction. Editing in place keeps one published version and is trivially revertible by restoring the prior `title:` strings.

### Dead `soap` fields — APPLIED by WI #276 (optional field refs)

**Update (WI #280).** `solution-definition.high-level-requirements` is no longer
a dead field. WI #280 (cross-stage reuse) makes it `required: true`, adds a render
site in `soap.md.tmpl`, and lists it as a bare, gated entry in `soap`'s `requires`
— it is the agreed high-level-requirements set that `nfrs.requirements-traceability`
maps back to at detailed design (cross-stage-reuse report §5 G5). The other two
fields the SOAP report called dead (`context.opportunity`, `context.in-scope`) were
absorbed into the `background` / `introduction` merge in the same WI and no longer
exist under those ids. The historical analysis below is retained as written.

**Update (WI #276).** Part 3 is now done. WI #276 added an engine-level optional
field-ref syntax — a trailing `?` on a `requires:` `module.field` entry (`README.md`,
"gate passes when…" section) — that scopes the field into the artefact (rendered,
shown in the lightweight editor) *without* forcing it mandatory unless the field's
own `required` / `required-at` already makes it so. With that mechanism, `soap`'s
`requires` moved from `[context, solution-definition, team-and-estimates]` to the
field-level list below, in `soap.md.tmpl` section order:

```
context.driver, context.affected-domains, context.out-of-scope?,
solution-definition.process-flow, solution-definition.high-level-solution-overview,
solution-definition.assumptions-and-considerations?, solution-definition.feature-breakdown,
team-and-estimates.teams-required, team-and-estimates.estimates, team-and-estimates.references?
```

The three dead fields (`context.opportunity`, `context.in-scope`,
`solution-definition.high-level-requirements`) are dropped. The three
conditionally-rendered fields (`context.out-of-scope`,
`solution-definition.assumptions-and-considerations`, `team-and-estimates.references`
— all `required: false`) carry `?`, so the `business-case` gate is exactly as
strict as it was under the whole-module list. Both fixtures (`examples`,
`atlas-reference-design`) still pass `check --gate business-case`, and the rendered
SOAP output is byte-identical. `soap-full` is untouched (its own `requires` list is
independent and still names the "dead" fields as bare, gating entries).

The findings below are retained as the original analysis.

### (Historical) Dead `soap` fields — still open after the WI #274 grill (Part 3 NOT implemented)

The SOAP report (R-P1/R-P2/R-P3) recommends removing `context.opportunity`, `context.in-scope` and `solution-definition.high-level-requirements` from the `soap` artefact — they are Full-SOAP concepts that `soap.md.tmpl` never renders. The WI #274 grill asked whether the in-place mechanism (converting `soap`'s `requires` from the module-level list `[context, solution-definition, team-and-estimates]` to an explicit `module.field` list) could be applied without tightening the `business-case` gate. **It cannot, and Part 3 was not implemented.**

Findings:

- **No optional-entry syntax exists.** A field-level `requires` entry is a plain `module.field` string. `splitArtefactRequirement` (`lib/definition.js`) just splits on the first `.`; there is no `{ field: x.y, required: false }` object form and no `?` suffix. `lib/status.js`'s `artefactRequirements` pushes every `module.field` entry straight into the gated-fields set **without consulting `isFieldRequired`** — so a field-level entry gates regardless of the field's own `required:` flag or `required-at`. `README.md` documents only "whole module ids or `module.field` references". `required-at` is a field-schema property (a list of gate ids), not a `requires`-entry modifier, and the field-level `requires` branch never reads it.
- **What a field-level list would force mandatory.** Built from the fields `soap.md.tmpl` actually renders (and omitting the three dead ones, which the template never renders anyway): `context.driver`, `context.affected-domains`, `context.out-of-scope`, `solution-definition.process-flow`, `solution-definition.high-level-solution-overview`, `solution-definition.assumptions-and-considerations`, `solution-definition.feature-breakdown`, `team-and-estimates.teams-required`, `team-and-estimates.estimates`, `team-and-estimates.references`. That makes `context.out-of-scope`, `solution-definition.assumptions-and-considerations` and `team-and-estimates.references` — all currently `required: false` — mandatory at `business-case`.
- **Editor scope.** `web/lib/artefactSelection.js` `artefactFieldIds` scopes the lightweight-SOAP editor's visible fields to the selected artefact's `requires`; a field-level list would also narrow the editor to exactly those fields whenever `soap` is selected, hiding any field not listed and any author-inserted custom section.
- **Fixture impact.** Both in-repo fixtures (`examples`, `atlas-reference-design`) already fill all three optional fields, so `node bin/gantry.js check <slug> --gate business-case` would **still pass** for them. The gate-tightening bites only real instances that leave those fields blank.

The PO's options remain: (a) accept the editor/gate trade-off; (b) render the three dead fields in `soap.md.tmpl` and update the reference sample, keeping the whole-module `requires`; (c) add an optional-entry syntax to the `requires` schema (an engine change, not a definition edit); or (d) cut `design/2`. `soap.requires` is unchanged: `[context, solution-definition, team-and-estimates]`.

The `soap-full` artefact gains a `caveats` field (`soap-full-details.caveats`, defaulting to the eight caveat bullets previously hard-coded in the template) so the one reference section with no authoring home now has one, and its `requires` list is reordered to follow the reference document's section order.

## Alternatives considered

- **Cut `design/2`.** Rejected: forces a version migration on every instance for a label-only correction, with no data or `id` change to justify it.
- **Template-level heading overrides instead of module `title:` renames.** Rejected: the module-editor label is the thing the reports say is wrong; overriding only the rendered heading would leave the editor still showing the mismatched wording.
- **Convert `soap` to a field-level `requires` now to drop the three dead fields.** Rejected for this ticket (see "Dead `soap` fields" above): it changes editor scope and gate semantics, which is out of scope for a title reconciliation. Left for the grill.

## WI #274 — reconciliation round 2 (in place)

The design grill returned a second round of in-place edits to `definitions/design/1/`:

- **Two id contradictions fixed.** `solution-definition.high-level-solution-design` → `high-level-solution-overview` and `team-and-estimates.teams-and-contacts` → `teams-required`, so each id matches its title. Ids are referenced by `id` from the templates and the `soap-full` `module.field` `requires` list; those and every fixture/test reference moved in lockstep. Titles unchanged, so no instance data migration and no rendered-output change.
- **Four display-title nits.** `context.in-scope` → "In scope", `context.out-of-scope` → "Out of scope", `solution-definition.high-level-requirements` → "High-level requirements", `alternatives-considered` module → "Alternatives considered". Fixture instance headings and heading-hard-coding tests updated to match.
- **`soap-full.md.tmpl` `## Metadata` heading dropped** (F12/F13 in `docs/reconciliation/template-consistency.md`): the five metadata fields now open the document as a bare table like the rest of the template.
- **Part 3 (drop the three dead `soap` fields)** — deferred here, then **applied by WI #276** once the optional field-ref syntax existed to do it without tightening the gate. See the "APPLIED by WI #276" section above.

## Status

Accepted; extended by WI #274, then by WI #276 (which applied Part 3 — see "APPLIED by WI #276" above). The PO may revisit the individual wording choices in the design grill; because the changes are title/id-only and in place, any revision is a further edit, not a version cut. The dead-`soap`-fields question is now resolved.
