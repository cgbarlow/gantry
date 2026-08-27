# SAD and SSAD use field-accurate requirements over shared modules

SAD and SSAD remain two renderings of the same detailed design data and share
the `build-ready-checklist` gate. They are not independently authored module
sets. Their `requires` lists are nevertheless different because the source
documents present different views of that data: SAD is the complete solution
architecture record, while SSAD is the support-focused operational view.

The landed requirements are:

- **SAD:** `architecture.business-context`, `architecture.design-decisions`,
  `architecture.solution-description`, `architecture.logical-components`,
  `architecture.standards`, `architecture.architectural-risks`,
  `architecture.constraints-and-assumptions`, `integration.interfaces`,
  `integration.network-and-infrastructure`, `integration.environments`,
  `data.logical-data-model`, `data.data-classification`,
  `data.data-retention-and-archiving`, `data.data-migration`,
  `data.data-replication`, all six `nfrs` fields, all four `security` fields,
  both `risks` fields, both `dependencies` fields, and
  `support-and-operations.support-handover-readiness`.
- **SSAD:** all seven `support-and-operations` fields,
  `architecture.solution-description`, `architecture.logical-components`,
  `architecture.architectural-risks`, `integration.interfaces`,
  `data.data-classification`, both `risks` fields,
  `nfrs.availability-and-continuity`, `nfrs.disaster-recovery-and-backup`,
  `nfrs.scalability-and-capacity`, `security.identity-and-access`,
  `security.privacy-and-confidentiality`, and
  `dependencies.dependency-list`.

The SAD list follows the headings in `reference/current_design_artefacts/SAD
Template.docx` as represented by the existing module specs and `sad.md.tmpl`.
The SSAD list follows the support, solution overview, risk, availability and
dependency sections in `reference/current_design_artefacts/FV Help Tool
SSAD.docx` as represented by `ssad.md.tmpl`.

The SSAD source is one filled Family Violence Help Portal example, not a
canonical blank template. Product-specific content such as the named Family
Violence services, individual URLs and vendor choices was therefore not
turned into new required fields. Existing generic support, environment,
architecture, security and operational fields capture the reusable structure.

This preserves the module-reuse decision in ADR-0001 while allowing the
instance editor to show only the fields relevant to the selected artefact.

Status: accepted.
