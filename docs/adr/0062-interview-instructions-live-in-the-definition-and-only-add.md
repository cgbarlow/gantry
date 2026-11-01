# Interview instructions live in the Definition, and only add to Gantry's rules

Ticket #246, map #238 (v0.13.0, the AI interview).

When the AI interviews an architect to draft a Stage, it follows two sets of
instructions. The first is **Gantry's own**: how to run the interview (draft
from the Source documents first, then ask rounds of question cards), how to
mark where each fact came from (a `source:` citation, plain fact from the
architect, or "(target assumption)"), never invent figures or names, never
pass a Gate. The second is **Interview instructions** written by the
Definition's author.

Interview instructions are an optional `interview:` text key at three levels:
the Definition, a Stage, and a Module. They stack from broad to narrow. A
Field has none, because its existing `guidance` already does that job. They
are edited on a draft Definition's Definitions page and published with it, so
an Instance's interview is fixed by its Definition version like everything
else the Definition says.

They can only **add**: what to ask about early, what to probe, tone, spelling,
the organisation's own habits. They never override Gantry's rules, and
Gantry's checks on each drafted Field (select values, word budget, uncited
figures) apply whatever the Definition says. A passed Gate has to mean the
same thing in every Definition, and provenance marks have to read the same in
every Artefact.

## Considered options

- **No Definition-authored instructions in v0.13.0.** Purpose, guidance and
  word budgets already speak to the AI. Rejected: an organisation's process
  has interview habits (what a business case reviewer always asks first) that
  belong to no one Field.
- **Instructions that can override named rules**, such as a Definition's own
  citation style. Rejected for the reason above.
- **Separate prompt files beside the Definition.** Rejected: a key in the
  YAML the Definitions page already edits keeps one authoring surface and one
  versioning story.
- **A per-Field interview note alongside `guidance`.** Rejected as two places
  to say the same thing.
