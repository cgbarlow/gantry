# Reconcile the `design` definition against the reference documents; extract shared modules for recurring sections

WI #227. The `design` definition's stage → artefact → module → field
structure had drifted from the approved reference documents it reproduces.
First observed on Operational Handover: the approved
`ATLAS – Migration Infrastructure Design` opens Terms & Definitions →
Introduction → Overview → Purpose → Scope, but gantry's `as-built-notes`
module opened "Business process flows", with the reference's real sections
buried as `###` sub-headings inside a free-text field of the
`atlas-reference-design` instance.

A full per-stage reconciliation (every `design` stage against every reference
in `reference/current_design_artefacts/`) is recorded in
`docs/research/design-definition-reference-reconciliation.md`. Headline: the
`shape` and `hld-define` stages have essentially no drift; `detailed-design`
(SAD/SSAD) has moderate drift (missing first-class Introduction / Overview /
Scope and Glossary sections); `handover` has the significant drift that
triggered the WI.

## Decision

Model recurring reference sections as shared modules, referenced from every
artefact that needs them — the existing `nfrs` / `risks` / `security` /
`dependencies` pattern (`docs/adr/0003`) — rather than re-implementing them
per stage. Four new modules:

- **`glossary`** (`terms-and-definitions`) — the SAD "Glossary", SSAD
  "Glossary" and ATLAS "Terms & Definitions". `required-at:
  [build-ready-checklist, operational-handover]`; referenced from `sad`,
  `ssad` and `as-built`.
- **`introduction`** (`overview`, `purpose`, `scope`, `constraints`,
  `assumptions`, `caveats`, `design-principles`, `outcomes-and-deliverables`)
  — the recurring opening framing.
- **`recovery-plan`** (`recovery-approach`, `resiliency`, `test-scenarios`,
  `raci`) — the SAD "Failure & Recovery" and ATLAS "Recovery Plan". Complements
  `nfrs.disaster-recovery-and-backup` (RTO/RPO/backup summary); this carries
  the full failover/resiliency/test/RACI detail.
- **`data-security-controls`** (`controls`, `inheritance-and-dependencies`) —
  the operational security control set the built solution runs under, distinct
  from the design-time posture in `security`.

`as-built-notes` is reduced to genuinely as-built-specific content
(`design-overview`, `architecture-decisions`, `process-flows`,
`infrastructure-and-configuration`, `appendix`, and the gantry-only
governance fields `changes-from-design` / `acceptance-criteria` /
`operational-notes` / `handover-confirmation`). The removed
`detailed-technical-design` field's content re-slices into `introduction`,
`glossary` and `as-built-notes.design-overview` / `.architecture-decisions`
with no loss; `business-process-flows` is renamed `process-flows`.

`as-built.md.tmpl` renders sections 1–7 in the ATLAS reference's exact order
(Terms & Definitions → Introduction → As-built design → Infrastructure →
Recovery plan → Data security controls → Appendix), then the four gantry-only
governance sections.

## Scope of this change (vs. deferred)

Applied now: the shared-module extraction, the full `handover` / `as-built`
reconciliation, `glossary` wired into `sad` / `ssad` (append-only, existing
section order unchanged), and the `atlas-reference-design` / `examples`
instance migrations.

Deferred to follow-up WIs (documented in the reconciliation doc, §8): wiring
`introduction` / `recovery-plan` / `data-security-controls` into
`detailed-design` and reordering `sad.md.tmpl` / `ssad.md.tmpl` to their
reference templates' top-level order. These need the SAD/SSAD instance prose
re-sliced without double-rendering content shared with the HLD, which is a
larger and riskier change than the originally-reported case warrants holding
up.

## Notes

- A `module.field` entry in an artefact's `requires` is checked for
  non-emptiness regardless of the field's own `required` flag, and a bare
  module id requires the module file to exist. `as-built`'s `requires`
  therefore lists only the fields that must gate; the template's `if` guards
  render the optional shared-module fields when an instance fills them.
- Tests updated: `tests/render.test.js` (seed `glossary.md` for the
  detailed-design Azure DevOps render fixtures), `tests/stageAdvancement.test.js`
  and `tests/stageStatus.test.js` (fill the expanded handover module set, and
  `glossary` at detailed-design).

Status: accepted.
