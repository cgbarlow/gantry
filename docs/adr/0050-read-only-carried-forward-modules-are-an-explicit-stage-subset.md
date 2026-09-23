# A Stage names the Modules it mounts read-only; Gantry does not infer them

A Stage's `modules` list does two jobs at once. It is what the gate check and the renderer read, so
a later Stage whose documents print an earlier Stage's content has to mount that Module. And it is
what the instance editor shows as editable, with required markers, for whoever owns the Stage.

`recruitment-onboarding` v2 shows where that breaks. Provisioning is Technology's Stage, but its Hire
Record prints the role, the engagement, the selection, the vetting, the offer, the contract and
payroll — so Provisioning mounts all of HR's and Payroll's Modules, and the editor offers Technology
every one of them as editable and required. Content signed off at an earlier Gate can be changed
behind that sign-off by someone who doesn't own it, and the editor asks a Stage owner for content
that isn't theirs (spec #147, user stories 30–32).

**Decision**: a Stage may list a subset of its `modules` under `read-only-modules:`. That list changes
editing only.

1. **Every loader, the gate check and the renderer keep reading `modules`.** A read-only Module still
   counts toward the Stage's Gate and still renders; nothing about what a Gate needs or a document
   prints changes. `read-only-modules` survives every Definition lifecycle operation as a
   pass-through key (#148).
2. **The instance editor shows a read-only Module as its saved content**, with no editors, no
   required markers, no Insert and a note naming its **home Stage**: the nearest earlier Stage that
   mounts the Module and does not list it read-only. Nearest, not first, so a Module handed on through
   several Stages names the last one that could edit it.
3. **The server refuses a write to a read-only Module at that Stage** — both module-write routes,
   before any stage branch is created or file written — with a 400 naming the home Stage. The Stage is
   the one the write is for: the browsed `?stage=`, else the instance's current Stage. The Gantry MCP
   server's `update_instance_modules` is a client of the same route, so it is refused the same way.
4. **Validation flags an id the Stage doesn't mount**, or a value that isn't a list
   (`unknown-read-only-module`, `invalid-read-only-modules`). Like every other Definition problem it
   blocks save, publish and `gantry validate` and shows as a marker on the Definitions page; unlike
   them it doesn't stop `loadDefinition`, so an existing instance keeps loading — a stray id only ever
   names a Module the editing surfaces never show.
5. **Read-only works per Module, not per Field.** A Stage that needs one Field of an earlier Module
   editable mounts that Module editably.
6. **It is opt-in.** A Stage without the key behaves exactly as before, so `design` and
   `recruitment-onboarding` v1 and v2 are unchanged. The Definitions page offers a per-mounted-Module
   "read-only" checkbox on a draft, and drops the key when nothing on the Stage is marked.

## Alternatives considered

- **Infer read-only from the Stage order** — a Module is editable at the first Stage that mounts it
  and read-only at every later one. Rejected: it breaks `design`, whose `nfrs`, `security`, `risks`
  and `dependencies` are one Module each, mounted at two or three Stages and filled in progressively
  (CONTEXT.md, **Module completeness by gate, not by authorship**; `docs/adr/0002`, `docs/adr/0003`).
  Inference would make the later Stages' half of that content impossible to write. It would also
  change the behaviour of every published Definition at once, where an explicit key changes only the
  Definitions that ask for it.
- **An explicit owner per Module** (`owner-stage:` on the Module). Rejected: a Module can have more
  than one legitimate authoring Stage (`design`'s progressive Modules again), and in
  `recruitment-onboarding` v3 the same Module is read-only at one later Stage and editable at another
  (`selection` stays editable at offer-contract-payroll so released reserve finalists can be recorded,
  but is read-only at appointment and provisioning). Whether a Stage may edit a Module is a fact about
  the Stage's mount, not about the Module.
- **Unmount the Module and let the gate check and renderer read Modules the Stage doesn't list.**
  Rejected: `docs/adr/0019` made a Gate's scope the Artefacts' `requires`, but the renderer, the
  editor's Artefact filter and the status twins all assume a Stage's Modules are its `modules`.
  Splitting "readable here" from "listed here" would touch every one of them; splitting "editable
  here" touches only the editing surfaces.
- **Hide read-only Modules from the editor.** Rejected: the Stage owner often needs to see them — the
  hiring manager's handover draws on the role and the contract — and the note saying where they are
  edited is the point.
- **Read-only per Field.** Rejected for now: nothing in spec #147 needs it, and a per-Field list
  would be a second requiredness-like axis on every Field. `required-at` already lets a carried Field
  stop being required at later Gates.

## Consequences

- The instance editor and the server now agree on what a Stage owns; a direct API or MCP write can't
  change content behind the Stage that signed it off.
- The rule lives once, in `web/lib/readOnlyModules.js`, imported by `lib/` (as
  `lib/workspaceDirectory.js` already imports `web/lib/localWorkspace.js`) and by the
  local-workspace twins, instead of as a server copy and a browser port that could drift.
- A local workspace's Save writes through the browser's folder handle, not the server, so for a local
  workspace the editor is the only guard. That matches everything else a local workspace does
  (`docs/adr/0029`).
- An older Gantry ignores the key: the Definition still loads and every Module is editable, as it was
  before this decision. That degrades to the old behaviour rather than to anything unsafe.

Status: accepted. Implemented by #152 (spec #147).
