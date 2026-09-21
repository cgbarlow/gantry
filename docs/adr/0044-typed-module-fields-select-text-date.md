# Module fields are a small typed vocabulary, not markdown and a bullet list

Gantry has had exactly two field types since the beginning: `markdown` and
`list`. `VALID_FIELD_TYPES` in `lib/definition.js` is a two-element set, its
twin in `web/lib/localDefinitionFiles.js` says the same, and the definition
editor offers the same two in a picker. Everything a process needs to record
has been recorded as prose, and mostly that has been right — a definition is
a document, and prose is what documents are made of.

Two things it is not right for showed up together.

The first is constrained choice. `recruitment-onboarding/1` has seven fields
whose permitted answers the definition already states, in prose, in the
guidance: `engagement.type` names four engagement types, `engagement.approval-route`
names two routes, and `offer.status`, `vetting.outcome`,
`payroll.validation-outcome`, `device.build-status` and
`handover.readiness-confirmation` each name theirs. Stating an enumeration in
guidance and then accepting free text against it means the enumeration is
advisory: the values drift, and nothing can be counted across instances.
`engagement.yaml` asks explicitly for the counting — a contractor engagement
covering ongoing work is "a recurring pattern worth being able to count
later" — and free text does not deliver it.

The second is that ADR-0045 needs short, single-line values to name rendered
documents from, and no field type produces one. Every field in
`recruitment-onboarding/1` is authored as prose:
`selection.preferred-candidate` asks who was chosen *and why*;
`contract.start-date` asks for the agreed day *and*, where it moved, the
original date and what moved it. Neither yields anything that can go in a
filename without guessing where the useful part ends.

**Decision**: three new field types — `select`, `text` and `date` — and the
rules that make them safe to store in a Markdown file that humans also edit
by hand.

1. **`select`** carries an `options:` list of **plain strings**. The chosen
   string is what the instance file stores, verbatim, and what templates
   interpolate. There is no key/label indirection: instance files are read
   in pull request diffs and their values flow straight into rendered
   documents, and an offer letter that says `fixed-term` because a template
   forgot a lookup is a worse failure than the rename problem indirection
   would have solved. A definition version is immutable, so renaming an
   option is a new version by construction — the same boundary a stable key
   would have protected.

2. **`multiple: true`** is a variation *within* `select`, not a second type
   name. Absent, the field holds one value on one line. Present, it holds
   several, written as bullets — byte-identical to how `type: list` already
   writes, so multi-select round-trips through the existing parser with no
   new storage format and reads correctly in a diff.

3. **`text`** is a single-line string. **`date`** is a calendar date, stored
   as ISO 8601 (`2026-11-03`) and authored through a date picker. ISO is
   canonical in the repo because it is unambiguous, sorts correctly in a
   folder listing (which is most of the point of a date in a filename) and
   diffs cleanly; templates get a formatting helper so a candidate-facing
   document can say "3 November 2026" without a second stored value existing
   to disagree with the first.

4. **`default:`** is optional on a `select`, and takes effect by
   pre-selection in the editor, written on the first save of that module —
   **not** at instance creation. The convenience is real, but a default
   written at creation means a required classification is satisfied from
   birth and an instance nobody opened can pass its gate on values nobody
   chose. Writing on save keeps "defaulted" meaning "someone was here".

5. **A value that is not in the option list is preserved, flagged and not
   blocking.** The editor shows it as a marked extra entry so a subsequent
   save cannot quietly overwrite it, `check` reports it, and the gate still
   passes. This is the rule the parser already follows for content it does
   not recognise — an unknown `##` heading is kept as a custom field rather
   than dropped (`lib/instance.js`) — and it matters because instance
   content is Markdown in a git repo that people legitimately edit by hand.
   Destroying authored content to satisfy a schema is the one outcome worth
   ruling out absolutely.

6. **A `select` is a closed set; there is no "Other".** Where a field today
   carries a classification *and* a qualifying sentence, the definition
   splits it into two fields — the dropdown, and a markdown field beside it.
   An `Other:` option is how closed sets rot, and a field that is only
   sometimes countable is not worth the type.

7. **Both YAML writers must be taught the new keys.** `buildModuleYamlObject`
   and its twin `renderModuleYaml` rebuild each field from a fixed key
   whitelist — `id`, `title`, `type`, `required`, `required-at`, `guidance`,
   `copied-from`. Leaving either untouched is not "unsupported": it deletes
   `options:` the first time anyone saves that module in the definition
   editor. The same applies to `filename:` on an artefact (ADR-0045). This is
   why the change lands across both twins, both editors, validation, render,
   MCP and CLI together rather than in increments.

Alternatives considered and rejected:

- **`options:` on a `markdown` field**, leaving `type` alone — rejected. It
  degrades quietly on an older Gantry: the unknown key is ignored, the field
  renders as a free-text box, and the constraint is gone with no signal.
  Gantry already treats `type` as a closed set and fails loudly on anything
  else; a definition that silently loses its constrained values is worse than
  one that will not load.
- **`key` / `label` option pairs** — rejected, as in §1.
- **A separate `multi-select` type** — rejected: two entries in the type
  picker differing by a hyphen, for one behavioural flag.
- **`allowOther: true`** — rejected, as in §6.
- **Writing `default:` at instance creation**, or applying it only at render
  — rejected. The first lets untouched instances pass gates; the second
  produces documents asserting something their source file does not say,
  which is indefensible in an audit.
- **No new types at all**, taking a filename from the first line of a
  markdown field — rejected: it makes filename quality a function of how
  tersely each author happens to write, and silently produces
  `Jane Smith, chosen for her platf - Offer.docx`.

Costs accepted knowingly: an older Gantry refuses a definition that uses the
new types, with an "unknown type" error — chosen over silent degradation. And
`date` adds a formatting concern to templates that markdown fields never had.

Status: accepted.
