# Full SOAP is a second Shape-stage artefact, built by extending soap's existing modules

Depends on 0019 (gate-passing moves per-artefact, which is what makes this
possible at all without forcing every SOAP author through the heavier
document).

Sourced from `reference/current_design_artefacts/JEDI-Full SOAP
Template-240826-023808.pdf` — a real, heavier variant of the same
Confluence-style Epic SOAP family the existing `soap` artefact is already
modelled on (see `CONTEXT.md`'s SOAP entry), not the TAC/HLD paper; no
naming collision with the HLD artefact.

**Module reuse, not a separate module set** (per CONTEXT.md's own stated
principle and the `dependencies`-duplication mistake it already documents,
docs/adr/0003): the new content extends `context`, `solution-definition`
and `team-and-estimates` — the same modules `soap` already uses — with new
fields required only for `soap-full`, plus reuses the existing
`dependencies` module (extending `dependencies-overview`'s `required-at` to
include `business-case`, the same progressive-fill pattern that module
already uses across `hld-tac-approved`/`build-ready-checklist`) rather than
inventing a second dependencies concept. `teams-and-contacts` and
`estimates` (both already free-text list fields) are reused as-is for
"Teams required" and person-day estimates — the template's fixed
team-checkbox UI and its t-shirt-size-vs-person-days distinction are both
authoring-format details, not new domain concepts, so they don't force new
fields.

New fields, only where nothing existing fits: `context` gains `opportunity`
and `in-scope` (the template's own explicit In Scope section — `context`
today only has `out-of-scope`, no counterpart); `solution-definition` gains
`high-level-requirements` (a structured Section/Requirement table — a
different shape from `feature-breakdown`'s existing prose, not a
duplicate). A new module, `soap-full-details`, houses what has nowhere else
to live: the metadata block (Epic/Project, requested-by, key dates),
Questions, and Caveats.

No new field types. The template's fixed team checklist becomes free-text
list entries (matching `teams-and-contacts`'s existing shape); the
Sequencing section's phased Gantt chart becomes a plain markdown table
(Requirement/Team/Estimate/Notes, matching the template's own table
exactly) with no visual timeline. Caveats is boilerplate the template
reuses verbatim across every SOAP, not per-instance authored content — it
belongs in the artefact's `.md.tmpl` as static text, not a module field a
person fills in each time.

Alternatives considered and rejected:

- **Mermaid-rendered Gantt chart for Sequencing** — investigated directly:
  no Mermaid support exists anywhere in this stack today (confirmed against
  the markdown-it preview pipeline and the raw pandoc export, neither has
  it wired in). A Mermaid `gantt` block wouldn't need a new field type
  (markdown fields already accept arbitrary fenced code), but getting it
  into the exported `.docx` needs a real new rendering capability —
  rasterizing the diagram server-side before pandoc sees it, plausibly
  reusing this repo's existing Playwright/Chromium dependency rather than
  a new toolchain. Rejected for this first cut as its own, separable
  problem — worth a dedicated follow-up ticket, not bundled into an
  already-large schema change.
- **A fixed-option checklist field type** for Teams required, matching the
  template's actual checkbox UI — rejected for this first cut alongside
  Mermaid: real new field-type infrastructure (schema + editor UI) beyond
  this change's core scope. `teams-and-contacts` already captures the same
  information as free text.
- **A wholly separate module set for `soap-full`** — rejected; see the
  module-reuse rationale above and 0019's own reasoning for why the two
  artefacts can now diverge in requiredness without needing to diverge in
  which modules they touch.

Status: accepted.
