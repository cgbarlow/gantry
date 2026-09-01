# Cross-stage reuse: a `background` + `introduction` backbone for the `design` definition

WI #280. The cross-stage-reuse audit (`docs/reconciliation/cross-stage-reuse.md`,
WI #270) found that the `design` definition's Shape and HLD framing modules
share no instance file with each other or with the detailed-design/handover
backbone, so any concept that logically progresses business-case → TAC → build
(scope, assumptions, the solution outline, problem framing) has to be re-typed
at each stage. The 8-module backbone (`nfrs` / `risks` / `security` /
`dependencies` / `glossary` / `introduction` / `recovery-plan` /
`data-security-controls`) already works; the gap is the Shape↔HLD boundary and
the "written at Shape, lost before handover" concepts.

A design grill turned the audit's R1–R5 recommendations into this change.

## Decision

Edit `definitions/design/1/` **in place** — the already-published version, per
the precedent of ADR-0027 (`design/2` would force a version migration on every
instance for what is a wiring and id change, not a semantic break). Instance
data migrates for the two in-repo fixtures only (`examples`,
`atlas-reference-design`); the live
`interactive-architecture-publishing-and-hosting` instance is handled
separately (WI #275 pt 2).

### 1. Merge `context` + `problem-statement` → `background`

`context` is renamed to `background` (`id: background`, title unchanged:
"Background and context"). The HLD-only `problem-statement` module is merged
into it and deleted. Field set:

| field | source | `required-at` |
|---|---|---|
| `problem` | `context.driver` + `problem-statement.current-state` | `[business-case, hld-tac-approved]` |
| `affected-domains` | `context.affected-domains` (unchanged) | `required: true` |
| `opportunity` | `context.opportunity` + `problem-statement.desired-future-state` | `[hld-tac-approved]` |
| `success-criteria` | `problem-statement.success-criteria` | `[hld-tac-approved]` |

`problem` describes the current state only; its guidance points the desired
end state at `opportunity`. `background` is now in the `shape` and `hld-define`
stage `modules:` lists (replacing `context` and `problem-statement`
respectively).

### 2. `introduction` as the scope + assumptions backbone

- `introduction.scope` is split into `introduction.in-scope` and
  `introduction.out-of-scope` (both `markdown`). The "silence on out-of-scope
  is the most common cause of a design being sent back" guidance moves to
  `out-of-scope`.
- `introduction` is added to the `shape` and `hld-define` stage `modules:`
  lists. `introduction.in-scope` / `.out-of-scope` are added to `soap`,
  `soap-full`, `hld`, `sad`, `ssad` and `as-built` `requires`, replacing
  `context.in-scope` / `context.out-of-scope` / `problem-statement.scope` /
  `introduction.scope`. Scope now has one persistent home from business-case
  through handover.
- `solution-definition.assumptions-and-considerations` is deleted.
  `introduction.assumptions` / `.constraints` / `.caveats` (kept
  `required: false`) are scoped into `soap-full` and `hld` `requires` with the
  `?` optional suffix (WI #276), and their guidance says "Capture from Shape
  onward — this file re-opens at every later stage."
- `architecture.constraints-and-assumptions` is renamed
  `architecture.constraints` (title "Constraints and goals"). Its guidance now
  covers architecture-specific constraints/goals only and cross-references
  `introduction.assumptions`.

### 3. `required-at` truthfulness (audit R4)

`introduction.overview` / `.purpose` / `.in-scope` / `.out-of-scope`,
`recovery-plan.recovery-approach` and `data-security-controls.controls` now
declare `required-at: [build-ready-checklist, operational-handover]`, matching
the `sad` artefact's field-level `requires`. No gate-behaviour change — the
`soap` / `hld` / `ssad` / `as-built` artefacts list the scope fields as bare
`requires` entries, which gate regardless of `required-at`.

### 4. Shape traceability (audit G4/G5)

- `solution-definition.high-level-requirements` becomes `required: true`, gains
  a render site in `soap.md.tmpl`, and is a bare gated entry in `soap`
  `requires` — it is the agreed set `nfrs.requirements-traceability` maps back
  to at detailed design.
- `solution-definition.alternatives-sketch` (new, `required: false`, `?` in
  `soap-full` `requires`): a brief Shape-level alternatives note incl. "do
  nothing", expanded at `alternatives-considered` for TAC.

### 5. Guidance cross-references (audit R1)

Short sentence additions only: `proposed-solution` (strategy-alignment,
trade-offs, delivery-approach, cost-benefit → back to `solution-definition` /
`team-and-estimates`), `architecture` (business-context, design-decisions,
solution-description → back to `background` / `proposed-solution` /
`solution-definition`), `solution-definition` (high-level-requirements,
process-flow forward-refs), `nfrs` + `security` purpose (→
`data-security-controls.controls`), `open-questions.questions` (→ `risks`), and
a reciprocal boundary note on `background.problem` and `introduction.overview`.

## Rationale

- **Reduce duplication, carry the reusable fields.** Scope and assumptions are
  one statement refined per audience; giving them one file (mounted from Shape)
  means the architect refines rather than re-derives.
- **Gate only where relevant.** Stage-specific depth stays gated only at the
  stage that needs it (`required-at`), while the shared fields are scoped into
  earlier artefacts with `?` so they are visible and editable without blocking
  an early gate.
- **Ids are not sacred.** `context` → `background` and
  `constraints-and-assumptions` → `constraints` follow ADR-0027's precedent:
  templates and `requires` reference ids, so an id move is a lockstep rename,
  not a data migration.

## Kept separate on purpose

- **D2 — `solution-definition` / `proposed-solution` / `architecture` /
  `as-built-notes.design-overview` depth-staging.** Four deliberately
  different-depth, different-audience views of "the solution" (business case →
  TAC → build → rebuild). Merging them would force business readers to see
  build detail. Cross-referenced in guidance, not merged.
- **D7 — `risks` vs `architecture.architectural-risks` vs
  `open-questions`.** Three separated risk/uncertainty concepts; guidance is
  sufficient.
- **D8 — `risks.open-issues` vs `open-questions.questions` vs
  `alternatives-considered`.** Distinct-but-related; the conflation risk is
  cultural, not structural.
- **D9 — `nfrs.disaster-recovery-and-backup` vs `recovery-plan.*`.** WI #228
  deliberately kept both (Backup & Archiving Policy vs Disaster Recovery),
  rendered under one "Failure and recovery" heading.
- **D10 — `security` vs `data-security-controls`.** Design-time posture vs the
  concrete operational control set; guidance strengthened, not merged.
- **D11 — `support-and-operations` vs `integration` vs `dependencies`.**
  Support engineer vs builder vs planner; correctly separated (WI #230).
- **D12 — `team-and-estimates` vs `proposed-solution.delivery-approach` vs
  `architecture.logical-components`.** Depth-staged; cross-referenced.
- **D13 — `background.affected-domains` vs
  `support-and-operations.stakeholders` vs
  `integration.network-and-infrastructure`.** Three lenses on "who/where is
  touched"; distinct.
- **D14 — HLD `background` framing vs SAD `introduction` framing.**
  Intentionally separate (TAC vs Design Authority audiences), per the
  reconciliation doc §5. A reciprocal guidance note on both fields prevents a
  future "merge everything" proposal from violating that split.

Audit items R6–R10 (glossary earlier, support-and-operations to handover,
question continuity, data sensitivity earlier, cost/contact continuity) are
out of scope for this WI.

## Status

Accepted.
