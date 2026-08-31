# Reconcile SOAP / Full-SOAP / HLD titles in `design/1` in place

WI #268. The Phase 1/2 reconciliation reports (`docs/reconciliation/soap-reconciliation.md`, `soap-full-reconciliation.md`, `hld-reconciliation.md`) found ~12 module and field `title:` values in the `design` definition whose wording does not match the reference SOAP, Full SOAP and HLD templates those artefacts are meant to reproduce. The rendered `.docx` output already matches the reference documents (the templates hard-code their headings); the drift is entirely in the module-editor labels an architect sees while authoring, plus three dead `soap` fields and a `soap-full` `requires` order that does not follow the reference's section order.

## Decision

Apply the reports' recommendations by editing **`definitions/design/1/` in place** — the already-published version — rather than cutting a `design/2`.

Rationale:

- **Display-title only.** Every field and module `id:` stays the same. Templates read module data by `id`, so rendered artefact output is unchanged except for the two `soap` headings the reports explicitly ask to rename in the output (`Context` → `Background and context`, `Team and estimates` → `Teams, contact persons, and high-level estimates`).
- **No instance data migration.** No field is added to or removed from any instance's stored values; no `id` moves. The in-repo fixture instances (`examples`, `atlas-reference-design`) have their module-file `##`/`#` headings updated in lockstep because the instance parser matches sections to fields by `title` — but that is a mechanical heading-text edit, not a data migration, and live instances pick up the new editor labels immediately on next load (their next save rewrites the module file headings to the new titles automatically).
- **Reversible and low risk.** A `design/2` would force every existing instance onto a new definition version for what is a label correction. Editing in place keeps one published version and is trivially revertible by restoring the prior `title:` strings.

### Dead `soap` fields — deferred, not applied

The SOAP report (R-P1/R-P2/R-P3) recommends removing `context.opportunity`, `context.in-scope` and `solution-definition.high-level-requirements` from the `soap` artefact — they are Full-SOAP concepts that `soap.md.tmpl` never renders. **This is deferred to the design grill and NOT applied in this ticket.** The only in-place mechanism is converting `soap`'s `requires` from the module-level list `[context, solution-definition, team-and-estimates]` to an explicit `module.field` list. That conversion has effects well beyond a label fix:

- the lightweight-SOAP module editor scopes its visible fields to the selected artefact's `requires` (`web/lib/artefactSelection.js`), so a field-level list would also hide the template's conditionally-rendered sections (`out-of-scope`, `assumptions-and-considerations`, `references`) and any author-inserted custom sections whenever `soap` is the selected artefact;
- a `module.field` entry gates regardless of the field's own `required` flag, so `context.out-of-scope`, `solution-definition.assumptions-and-considerations` and `team-and-estimates.references` — currently optional — would become mandatory to pass the `business-case` gate.

Neither is a display-title-only change. The PO should decide in the grill between (a) accepting that editor/gate trade-off, (b) rendering the three fields in `soap.md.tmpl` and updating the reference sample, or (c) cutting `design/2`.

The `soap-full` artefact gains a `caveats` field (`soap-full-details.caveats`, defaulting to the eight caveat bullets previously hard-coded in the template) so the one reference section with no authoring home now has one, and its `requires` list is reordered to follow the reference document's section order.

## Alternatives considered

- **Cut `design/2`.** Rejected: forces a version migration on every instance for a label-only correction, with no data or `id` change to justify it.
- **Template-level heading overrides instead of module `title:` renames.** Rejected: the module-editor label is the thing the reports say is wrong; overriding only the rendered heading would leave the editor still showing the mismatched wording.
- **Convert `soap` to a field-level `requires` now to drop the three dead fields.** Rejected for this ticket (see "Dead `soap` fields" above): it changes editor scope and gate semantics, which is out of scope for a title reconciliation. Left for the grill.

## Status

Accepted. The PO may revisit the individual wording choices in the design grill; because the change is title-only and in place, any revision is a further `title:` edit, not a version cut.
