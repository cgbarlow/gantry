# The AI interview runs on pinned grilling and domain-modeling skills, with standard modules

Ticket #252, map #238 (v0.13.0, the AI interview). Revises parts of the
drafting rules decided in #246. Builds on ADR-0062 (Interview instructions)
and ADR-0064 (the decisions log).

The v0.13.0 map was itself planned with Matt Pocock's `grilling` and
`domain-modeling` skills (MIT). The AI interview had adopted a "grill-me
style" loosely and was reinventing it piece by piece: its own round size, its
own question order, its own handling of terms. Instead, Gantry uses the skills
wholesale.

**The skills ship as they are, at a pinned version.** Gantry bundles
`grilling` and `domain-modeling` unchanged, with their licence and credit. A
Gantry release moves to a newer version on purpose, with a CHANGELOG line, and
interviews behave the same until Gantry is upgraded. A short **adapter** maps
the skills' coding-agent terms onto Gantry's:

- `CONTEXT.md` → the Glossary standard module
- an ADR → a Key decision
- looking a fact up → reading the Source documents
- AskUserQuestion → question cards
- the shared-understanding check → the stage-end card

**Gantry's rules come first.** The order is Gantry's own interview rules, then
the skills, then the Definition's Interview instructions, which only add
(ADR-0062). The adapter lists each known conflict and how Gantry settles it,
so the model never has to guess. Examples: Gantry drafts before it asks,
because drafting is an unsaved preview and "acting" means a Save. Term choices
are logged and drafted into the Glossary module, not written to it straight
away.

What the skills bring to the interview:

- A round holds **every** question whose prerequisites are settled. Cards show
  four at a time and the round is submitted together.
- The dependency tree decides what is ready to ask. Gantry's priority order
  only sorts the cards within a round.
- Scenarios are used to stress-test the design while relationships are being
  discussed.
- Fuzzy or clashing wording is challenged, the architect's own included, not
  only Source documents that disagree.
- A Key decision is offered only when the decision is hard to reverse,
  surprising and a real trade-off.

**Standard modules.** The skills produce a glossary, decision records and open
questions. These are the same whatever the Definition, so Gantry provides
three **standard modules**: Glossary, Key decisions and Open questions. Each
has a fixed id and Field shape and a version, and a Definition names the
version it mounts. A Definition mounts them on whichever stages it chooses. It
can add guidance and Interview instructions to them, but cannot change their
shape. Where one is not mounted, the AI keeps that role in the decisions log
only.

**Key decisions** hold only decisions that pass the three-part test. The
decisions log still records every answer. Each Key decision has a stable
number, and a Definition can set the prefix (`design` keeps "AD"). A
Definition picks the **decision style**:

- **default**: title, context, decision, why, considered options,
  consequences.
- **WH(Y)** (github.com/cgbarlow/adr): a title, the six-part statement ("In
  the context of… facing… we decided for… and neglected… to achieve…
  accepting that…") and typed links to other Key decisions (depends on,
  supersedes, relates to).

The read-only view beside the Interview instructions editor shows Gantry's
interview rules and the skill versions. Each stage's decisions log records
the skill versions alongside the model.

## Consequences

- The interview's behaviour comes from text that is proven and maintained,
  and that the team already plans with. Gantry's own rules shrink to what is
  specific to Gantry: drafting first, citing, changing saved content only
  through cards, and when a stage is ready.
- Upgrading the skills is a deliberate Gantry change. A test checks that the
  adapter still covers every term the skills use.
- Standard modules make the AI's glossary, decisions and open questions the
  same shape in every Definition. The cost is a new kind of module that
  Gantry, not the Definition, owns and versions.
- The `design` v3 draft moves to the standard modules: its Glossary, its Open
  Questions, and its decisions table, which becomes Key decisions in the
  WH(Y) style with the AD prefix. The rule about which decisions need
  governance endorsement stays in `design`'s own guidance and Interview
  instructions.

## Considered options

- **Rewrite the skills as Gantry's own rules, with credit.** Rejected. The
  rewrite drifts from the original, and Gantry stops getting the skills'
  improvements.
- **Keep borrowing ideas piecemeal** (#246 as decided). Rejected as
  reinventing the wheel.
- **Always fetch the latest skills.** Rejected. An interview could change
  behaviour with no Gantry release, and it would need the network.
- **Let the skills override Gantry where they clash.** Rejected. That breaks
  draft-first and the rule that saved content changes only through cards.
- **Have each Definition point the roles at its own Fields**, either through a
  checked key or through Interview instructions text. Rejected by the product
  owner in favour of consistent modules that are the same in every
  Definition.
- **Put the standard modules in every Instance automatically.** Rejected,
  because it forces content on Definitions that don't want it. **Offer them
  as a template to copy** was also rejected: the shapes would drift and the AI
  couldn't rely on them.
- **Have no versions and allow only additive changes.** Rejected because the
  promise is easy to break by accident, and a published Definition must render
  the same forever.
