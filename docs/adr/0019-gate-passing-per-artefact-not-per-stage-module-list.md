# A stage's gate passes when any one of its artefacts is complete, not when a fixed module list is complete

Amends ADR-0001's stage/gate topology. Every gate today happens to have a
single answer to "what does complete mean," because every existing gate's
artefacts share one identical `requires` list. At the time of this decision,
SAD and SSAD both required exactly `[architecture, integration, data, nfrs,
security, risks, dependencies, support-and-operations]`; ADR-0021 later made
their requirements field-accurate while preserving the same per-artefact rule.
`checkGate` exploits that old coincidence directly: it evaluates the
*stage's* own `modules` list as one monolithic AND, never looking at
individual artefacts at all.

Adding a second Shape-stage artefact (`soap-full`, alongside the existing
`soap`) breaks that coincidence on purpose: `soap-full` reuses `soap`'s
existing modules but requires more fields on them (see
0020-full-soap-artefact.md for what and why), and the decision here (Chris
Barlow, 2026-08-25) is that completing *either* artefact's own requirements
closes the Business Case Approved gate — you don't need both a lightweight
SOAP and a full one before Shape can close. Once two artefacts under one
gate can genuinely have different requirements, "the stage's module list is
complete" stops being answerable at all: there's no single list left to
check.

Gate-passing moves from stage-level to artefact-level: a gate passes when
**at least one** of the stage's gate-matching artefacts (`definition.artefacts.filter(a => a.gate === stage.gate)`)
has all of *its own* `requires` fields complete, evaluated the same way
`evaluateStage` already evaluates completeness today — this changes *what*
gets evaluated, not *how*. `stage.modules` stays in the schema, but changes
role: it's now the union of everything the stage's artefacts might need
(what the module editor mounts and offers for authoring), not the
gate-passing source of truth.

This was initially a no-op for the detailed-design gate because SAD and SSAD
had identical `requires` lists. ADR-0021 now makes their lists diverge at the
field level without changing this rule: either artefact can still satisfy the
shared gate, and `stage.modules` remains the editor's union of available data.

This changes what "the gate passed" means for every caller that trusts it —
`requestStageApproval` (opening the approval PR), `advanceStage` (a local
instance's self-serve advancement), the work-item gate-pass sync, and the
auto-merge check (WI #125) — but not their own logic beyond the source of
their pass/fail boolean.

Explicitly **not** changed by this ADR: once a gate has passed via either
path, WI #159's rule stands as originally specified — *every* gate-matching
artefact that has its own required data present still gets rendered and
verified before a Pull Request opens, using the render pipeline's existing
skipped/rendered/error distinction to tell "never attempted, nothing to
render" apart from "attempted and failed." Either-suffices governs whether
the *stage can advance*; it says nothing about which documents get produced
once it does — an artefact whose data was never filled in is legitimately
skipped, not silently exempted from an otherwise-real render failure.

Alternatives considered and rejected:

- **Require both artefacts under a shared gate** — rejected per the
  2026-08-25 decision: forcing a lightweight SOAP author to also complete
  the full variant (or vice versa) defeats the point of offering two
  weights of the same document.
- **A stage-level flag choosing which artefact "counts"** (a mode switch
  set once per instance) — rejected as unnecessary indirection; evaluating
  each artefact's own completeness directly is simpler and doesn't require
  the author to declare a mode up front before they've decided which one
  they're writing.
- **Duplicate `stage.modules` per artefact in the schema** (an explicit
  per-artefact module list, redundant with `artefact.requires`) —
  rejected: `artefact.requires` already names exactly this; a second list
  saying the same thing would just be another place for the two to drift
  out of sync.

Status: accepted.
