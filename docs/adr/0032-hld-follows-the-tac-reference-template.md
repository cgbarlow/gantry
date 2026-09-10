# The HLD renders the TAC reference template's sections and nothing else

WI #362. The `hld` artefact in `definitions/design/2/definition.yaml` had grown
to 38 field references. The *2026 TAC Architecture High Level Solution Design
Template* has a cover block plus 19 headed body sections, one concept each, and
the WI #266 HLD reconciliation (`docs/reconciliation/hld-reconciliation.md`)
concluded "no new fields needed, no fields to remove". The gap opened up for
three reasons, none of them a decision about what a TAC paper should contain:

1. **Whole modules expanded to every field.** When `requires` went field-level
   (WI #318) so render order could match the reference, every field of `nfrs`,
   `security`, `risks` and `dependencies` was listed to keep editor scope
   unchanged. The reference has *one* section each for NFRs, Security and
   privacy, Risks and mitigations, and Dependencies.
2. **Backbone fields wired in for reuse.** `design-basis.assumptions` /
   `.constraints` / `.caveats` rendered as a `# Design basis` section the
   definition itself described as a deviation from the reference (WI #331).
   `background.affected-domains` and
   `solution-definition.high-level-solution-overview` are gantry-only additions
   with no reference heading at all.
3. **Fields that belong to a later gate.** `dependencies.dependency-list`,
   `nfrs.requirements-traceability`, `nfrs.disaster-recovery-and-backup` and
   `nfrs.scalability-and-capacity` are build-ready concerns surfaced at HLD.

Because the web editor filters visible fields by the selected artefact's
`requires` (`artefactFieldIds`, `web/lib/artefactSelection.js`), the HLD form,
the gate and the rendered document inflated together — one list, three symptoms.

## Decision

`hld.requires` carries **one entry per reference section, and nothing else**:
24 entries, in render order, using the field ids as consolidated since the
template was written (`problem-statement` → `background`; scope →
`introduction.in-scope` / `.out-of-scope`; questions → the shared
`open-questions`). Fourteen field references are dropped; the template loses
`## Affected domains`, `# Design basis`, `## Solution overview`,
`## Dependency list` and `## Open issues`, and collapses NFRs and Security and
privacy back to a single `##` heading each.

**Design basis is removed from the HLD**, reversing WI #331's "every artefact"
placement for this one document.

### Why the HLD gets an exception to the backbone

ADR-0028 established a cross-stage backbone — scope, assumptions, constraints and
caveats entered once and refined at every later stage — and WI #331 split the
conditions cluster out as `design-basis` and rendered it as an adjacent
`# Overview` / `# Design basis` pair near the front of every artefact that
carries it. That consistency is worth having, and it stays, for the Full SOAP,
the SAD and the As-built.

The HLD is different in kind. It is not a gantry document that happens to have a
reference; it is a **submission to a standing committee that has published the
paper's own structure**, section by section, and reads dozens of them against
that structure. A section the template does not have is a section the reader is
not looking for. Where the two principles collide — fidelity to the reference
versus cross-document consistency — fidelity wins for this one artefact, and only
for this one, because only this one is read by an external body against a
template it owns.

Nothing is lost by it. Every dropped field lives in a shared module that still
mounts at Shape or Detailed Design; assumptions, constraints and caveats are
still authored, still carried, still rendered in the Full SOAP that precedes the
HLD and the SAD that follows it. What changes is that the TAC paper no longer
carries a heading TAC did not ask for.

### Gate effect

No gate was loosened or tightened for either in-repo fixture: `gantry` still
fails `hld-tac-approved`, `kiwi-cover-mutual` still passes. Twelve of the
fourteen dropped references did not gate at `hld-tac-approved` at all. Two did:

- `background.affected-domains` (bare, `required: true`) — a genuine reduction
  in what `hld-tac-approved` re-checks. It stays mandatory at `business-case`
  via the `soap` artefact, which every HLD is downstream of.
- `solution-definition.high-level-solution-overview` (`required: true`, so the
  `?` suffix did not exempt it) — added to the HLD only in v2. Dropping it
  restores v1 behaviour, and it too stays mandatory at `business-case`.

The three fields the reference does mandate — `nfrs.performance`,
`nfrs.availability-and-continuity` and `security.privacy-and-confidentiality` —
stay bare entries and keep `required-at: hld-tac-approved` in their own module
YAML.

## Consequences

- The `hld-define` stage drops `design-basis` and `solution-definition` from its
  `modules:` list. `hld` is the stage's only artefact, so mounting a module no
  HLD section renders would put dead cards on the editor screen.
- The `design-basis` backbone accumulates at Shape, Detailed Design and
  Handover, but is not editable while the author is on the HLD stage. That is
  the cost of the exception, accepted: the fields are neither asked for nor
  shown in the document being written.
- ADR-0028's backbone reasoning is unchanged in substance; §2 of that ADR is
  annotated with a pointer here so the HLD exception is discoverable from it.

## Status

Accepted.
