# Copying elements between definitions: provenance, not live references

Feature #380 (First-class Definition Editor) needs a way for an author to pull an element — a stage, artefact, module, or field — in from another definition instead of retyping it. Two shapes were on the table: a **live reference**, where the borrowing definition points at the source element and picks up its future changes, and a **copy**, where the borrowing definition gets its own independent element, tagged with where it came from.

We chose copy with provenance. A copied element becomes ordinary, independent content in the target definition — editable, versioned, and validated exactly like anything authored there directly — carrying a `copied-from: {definition, version, element}` marker for traceability. Nothing about it stays live.

This follows directly from decisions already made elsewhere in the domain model, not from a fresh trade-off:

- **Published versions are immutable** (`lib/definition.js`'s `writeDefinitionVersion`). A live reference into a published definition would need to resolve against that definition's *future* versions to be useful as anything other than a permanent pin — which immediately reintroduces mutability into what "immutable" was meant to guarantee, or else pins to one version forever, which is just a copy with extra machinery.
- **Workspace definitions are not reachable from other workspaces** (`CONTEXT.md`, *Definition home*). A live reference is a standing read dependency between two definitions; allowing it across workspace boundaries would break that isolation, and disallowing it across boundaries while allowing it within one workspace would make "reference" behave differently depending on where you are — a distinction with no good story for an author.
- **A definition renders and validates on its own** — `findDefinitionProblems`, template rendering, and `gantry serve` all operate on one definition's own files with no cross-definition resolution step anywhere in the engine today. A live reference would be the first thing in gantry that made one definition's correctness depend on another definition still existing, in a compatible shape, at read time.

Provenance gets most of what a reference would have offered — you can see where something came from, and go compare against the source — without any of the run-time coupling. What it doesn't offer is automatic propagation: if the source changes, the copy doesn't. Re-copying is the deliberate mechanism for pulling in an update, matching this repo's "data over documents" bias toward explicit, one-shot actions over implicit sync.

## Alternatives considered and rejected

- **Live cross-definition references.** Rejected for breaking published-version immutability (above) and workspace isolation, and for making definitions non-self-contained in a codebase where every other read path assumes they are.
- **Symlink/import-style indirection** (a lighter-weight reference that still resolves at read or render time). Same objections as a live reference, plus new failure modes gantry doesn't have today: import cycles, a source definition or workspace becoming unreachable, and needing to decide what a dangling import renders as.
- **Version-pinned reference** (points at one specific version of the source, never moves). Functionally converges on a copy — the target only differs from a copy in that it still needs the source's files present to render — so it was folded into "just copy it" rather than kept as a third option.

## Consequences

- Collisions are a copy-time concern, not a render-time one: `web/prototypes/definition-copy.prototype.html`'s `CopyPlanner` is the primary source for id-collision handling (rename / replace / merge) when a copied stage or artefact brings its dependent modules along.
- A definition never fails to render or validate because some *other* definition changed or disappeared — the property this decision exists to preserve.
- Drift is expected and accepted: two definitions that copied the same module will diverge over time unless someone deliberately re-copies. This is a property of the design, not a gap to close later.

Status: accepted, first-cut. Written ahead of WI #382's implementation, per Feature #380's own instruction to record this decision when phase 2 starts.
