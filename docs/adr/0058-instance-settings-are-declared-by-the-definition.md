# Instance settings are declared by the Definition

Spec #223, tickets #219, #220 and #221. Amends ADR-0052 (where a cover's
classification comes from) and ADR-0054 (Target size's default).

Some choices belong to a whole Instance, not to any Stage's content. Gantry
has two of them, and handles them in two different ways.

**Target size** (ADR-0054) is already per Instance. It is stored as `size:`
in the Instance record, chosen in the "+ New Workspace" wizard, changed in
Instance Settings and set by MCP `create_instance`. But each of those places
wires it in on its own. The Definition doesn't declare it: Size appears
because some Field carries `target-words`, and its default is always Medium.

**Classification** is gate content. Design v3 mounts a `document-handling`
Module at every Stage, with one `select` Field, and each Artefact points its
`cover-classification` at that Field (ADR-0052). The stage editor shows a
"Document handling" section at every gate for a value that holds for the
whole Instance. It can't be chosen when the Instance is created. An
organisation with its own markings edits a Field's options rather than
stating its scheme.

So a Definition's author has no single place to say "each Instance chooses
this, from these, defaulting to that". An Instance's author meets the same
kind of choice in different places at different times.

## Decision

1. **A Definition declares its Instance settings.** An Instance setting is a
   per-Instance choice with an id, its **choices** and an optional
   **default**. One shared module answers, for a Definition, which settings
   it offers, their choices, defaults and effective values. Every surface
   reads that module: the wizard, Instance Settings, the Definitions page
   (server and Local Workspace), Instance creation, the settings write path
   and MCP. None of them hard-codes a setting.
2. **Two members to start.**
   - **Target size** (`size`). Its choices are fixed by Gantry: Small,
     Medium, Large. Every Field's `target-words` is written against them, so
     a Definition can't change them. A Definition may declare a default.
     Size is offered only when some Field declares `target-words`, as
     ADR-0054 §3 already says.
   - **Classification** (`classification`). Its choices are the Definition's
     own markings, stored verbatim (the **Option** rule, ADR-0044: no
     key/label indirection), with an optional default. It is offered only
     when the Definition declares markings. Choosing one is optional.
3. **Each is stored under its own key in the Instance record**, written only
   when a value is chosen, as `size:` is today. An Instance on a Definition
   without that setting never grows the key, and storing one there is
   refused.
4. **The effective value is: stored, else the Definition's default, else
   the setting's fallback.** Size falls back to Medium and Classification to
   blank. The editor's word targets, `get_instance`, a save's over-budget
   notes and the render all use the effective value. A Definition that sets
   no Size default behaves exactly as before.
5. **Every write is validated the same way.** A setting the Definition
   doesn't declare, or a value outside its choices, is refused by Instance
   creation (wizard and MCP), by the Instance Settings write and by MCP.
   This generalises today's `instanceSizeProblem`. A malformed declaration
   (a default that isn't one of the choices, duplicate or blank markings, an
   empty marking list) is a Definition problem. `gantry validate`, a Local
   Workspace and the Definitions page report it, and Save and Publish refuse
   it. Like `invalid-target-words`, it doesn't stop a Definition loading,
   because its readers ignore a malformed setting.
6. **Classification prints from the Instance.** A cover and its page header
   (ADR-0052, #207, #209) print the Instance's effective Classification, and
   a blank one prints nothing, as a blank Field did. When a Definition
   declares markings, any `cover-classification` pointer is ignored. When it
   declares none, a `cover-classification` pointer keeps working as before,
   so Definitions copied into other Library repos keep their markings. The
   Definitions page stops offering the pointer; its validation
   (`invalid-cover-classification`) stays.
7. **One Definitions page section, one editing rule.** "Instance settings"
   shows every setting the Definition offers, and on a draft edits each
   one's choices and default. Size's choices are shown but can't be edited.
   A published version shows the section read-only.
8. **The declaration is part of the Definition.** It survives every round
   trip (#148): save, new draft, clone, publish, promote, every Provider's
   loader, the Library cache and a Local Workspace's copy.
9. **People are not Instance settings.** Assignee and Required reviewer stay
   where they are. They are about who does the work, the Definition doesn't
   declare them, and they have their own routes and rules (ADR-0009).

## Design v3

v3 is a draft, so it changes in place. It declares Classification with the
four NZ PSR markings (UNCLASSIFIED, IN-CONFIDENCE, SENSITIVE, RESTRICTED) and
no default. It drops the `document-handling` Module from every Stage, every
`requires` and every `cover-classification`. The bundled examples
(`kiwi-cover-mutual`, `gantry`) store IN-CONFIDENCE as their Instance
setting. Any other v3 Instance loses a classification chosen in the old
Field and needs it chosen again. No migration is built, because v3 is a
draft.

## Alternatives considered

- **Keep Classification as a Field and just hide it from the gates.** That
  would mean a Module mounted at every Stage but shown at none, which is a
  Field in name only. It still couldn't be chosen at creation, and the
  editor would need a special case. Rejected.
- **Add Classification alongside Size, wiring each surface by hand.** This
  is the smallest change today. But a third setting would repeat the
  threading again through the wizard, Settings, the Definitions page, MCP
  and the write path, and the surfaces would drift. Rejected in favour of
  one declaration read everywhere.
- **Make Assignee and Required reviewer Instance settings too.** Rejected
  (§9): they aren't the Definition's to declare, and they carry rules of
  their own.
- **Let a Definition rename or add Size choices.** Rejected: every Field's
  `target-words` is keyed by Small/Medium/Large, so changing the choices
  would orphan budgets.
- **Retire `cover-classification` outright.** It is cleaner, but a copy of
  the v3 draft in another Library repo would lose its markings silently on
  upgrade, against spec #147's "an Instance already running on a Definition
  keeps loading after an upgrade". Kept as a fallback instead.
- **Migrate existing v3 Instances' Field values.** Not worth building for a
  draft Definition. Re-choosing in Instance Settings is one step.

## Consequences

- A Definition's author states in one place what every Instance decides,
  from what, with what default.
- An Instance's author meets every such choice at creation, in Instance
  Settings and over MCP, under one heading.
- The gates show only Stage content.
- A further Instance setting is a declaration plus whatever reads it, such
  as the render. It is not a change to each surface.
- ADR-0052's rule that "the classification comes from the Field the Artefact
  names" now applies only to Definitions that declare no markings.
- ADR-0054's "Medium is the default" now means "the Definition's default,
  else Medium".

Status: proposed. To be marked accepted when #219 lands.
