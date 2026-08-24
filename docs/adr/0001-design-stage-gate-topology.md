# Design definition: four stages, not README's illustrative three

README's worked example gives the `design` definition three stages (`shape` → `define` → `build-ready`). The real Contoso process resolves to four distinct gates (`docs/research/stages-gates-module-specs.md` Section 3): Business Case Approved, HLD approved at TAC, Build Readiness Confirmed, and Operational Handover completed and submitted to TAC for noting. We split `define` into `hld-define` and `detailed-design` so each real gate gets its own stage, rather than collapsing HLD approval into an internal checkpoint of a single `define` stage. A future reader comparing against README's worked example will otherwise wonder why the real definition doesn't match the doc.

Two related decisions made alongside this:

- **Design Authority is not modelled as a gate.** It reviews the SAD/SSAD architecture-related modules before Build Readiness Confirmed, but Gantry gives each stage exactly one exit gate. We track that review via the existing module frontmatter `status`/`owner` convention instead of adding a second gate or stage — bending the one-gate-per-stage model was considered and rejected as unnecessary complexity for what is a review step, not an independent go/no-go decision.
- **SAD and SSAD share one gate and one module set.** Per the 2026-08-17 clarification, SSAD is a variation on SAD serving the same purpose, not a structurally distinct artefact. Both are declared as separate `artefacts` entries in `definition.yaml` with identical `requires` lists, rather than each having its own gate or its own module set — consistent with Gantry's "data over documents" principle.

Status: accepted, first-cut. Design Authority's role here is a stated intent (Chris Barlow, 2026-08-17), not yet corroborated by a charter/ToR — revisit if that surfaces and contradicts this.
