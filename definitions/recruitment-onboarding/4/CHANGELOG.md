# Recruitment and Onboarding — changelog

## v4

Published with Gantry 0.13.0 (#309). v4 starts as a copy of v3, so every Stage, Gate, Artefact and
Field is as it was, and adds what the AI interview needs. v3 and earlier stay published and
unchanged, so live Instances on them are unaffected; moving an Instance to v4 is a per-Instance
step for the process owner. The bundled platform-engineer worked example has been moved to v4.

### Glossary and Open questions are Gantry's standard modules

v4 mounts the **Glossary** and **Open questions** standard modules (version 1 of each) on every
Stage, and does not mount Key decisions.

- **Glossary** is new. Its one Field, `terms`, is a table of preferred term, definition and the
  names to avoid. The Hire Record prints it as a closing Glossary, `glossary.terms?`.
- **Open questions** replaces v3's own `open-questions` Module. Its one Field, `questions`, is now
  a table (question, who resolves, by when, status) rather than a list of entries, and every
  Artefact that printed the list prints the table under the same "Open questions" heading.
  Answered questions now stay in the table with their status instead of being removed.
- **Process gaps** moves to a Module of its own, `process-gaps`, with the one Field `gaps` (it was
  `open-questions.process-gaps`), because a standard module's shape is fixed. It is still
  optional at every Stage and printed only in the Hire Record.

### Interview instructions

v4 carries its first Interview instructions: a Definition-level note that Instances hold HR
personal data (ask by role first, never ask for a CV, contract or payroll form to be pasted in),
a Selection note that vetting is recorded from HR's records and never guessed, and a Process gaps
note to keep to the process rather than who was at fault. The Glossary and Open questions mounts
add their own guidance and Interview instructions for this process.

### Moving an Instance from v3

Convert `open-questions.md`'s list to the table, move the Process gaps section into a new
`process-gaps.md` (`## Process gaps`), add a `glossary.md` (it can be empty), then set
`definitionVersion: 4`. No other Module changes.
