# SAD and SSAD get distinct, field-accurate `requires` lists instead of an identical placeholder

`definition.yaml` currently gives `sad` and `ssad` byte-identical `requires`
lists across all eight shared modules (`architecture`, `integration`, `data`,
`nfrs`, `security`, `risks`, `dependencies`, `support-and-operations`).
CONTEXT.md's own SAD/SSAD entry framed this as intentional — "two renderings
of one module set" — but that framing was never checked against the actual
source documents.

Reading `reference/current_design_artefacts/SAD Template.docx` (a full blank
template — Business Architecture View, Technology Architecture View,
Deployment View, Data View, Security View, Operating Considerations, ~20
major sections) against `FV Help Tool SSAD.docx` (the only real SSAD
example — Solution Products, Architectural Risks, Stakeholders/Domains/
Environments/Security/Release Procedures) shows genuinely different content,
not the same sections under two names. The identical `requires` lists
understate both documents' real scope and mask the fact that SAD and SSAD
diverge.

**Decision**: SAD and SSAD keep sharing the same *design* (SSAD remains
support-facing framing of the same solution, per docs/adr/0001 — not a
structurally independent document) but get their own field-accurate
`requires` lists, derived from the two source documents directly. Follow the
module-reuse principle 0020 already established for `soap`/`soap-full`:
extend existing shared modules and add fields only where nothing existing
fits, rather than inventing a parallel module set per artefact.

The FV Help Tool SSAD is a real filled example, not a template — the
coverage-assessment spreadsheet says explicitly no standard SSAD template
exists. Treat its section list as descriptive of one instance, not
prescriptive of every SSAD; where its content looks product-instance-
specific rather than structural, judgement is needed rather than a literal
one-to-one transcription.

Alternatives considered and rejected:

- **Leave `requires` identical, treat the divergence as a documentation-only
  fix** — rejected. The whole point of a `requires` list is to gate-check
  real content; leaving it inaccurate defeats the field-level artefact
  filtering this correction exists to support.
- **Give SAD and SSAD entirely separate module sets** — rejected, for the
  same reason 0020 rejected it for `soap`/`soap-full`: they render from one
  underlying design, and duplicating modules risks the exact
  `dependencies`-style duplication mistake docs/adr/0003 already documents.

Status: accepted.
