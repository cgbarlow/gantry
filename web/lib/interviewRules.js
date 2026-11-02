// #285 (docs/adr/0065, with #246 as revised by #252): **Gantry's interview rules** — the fixed rules
// the AI follows when it interviews an architect, whoever the Definition's author is. Nothing overrides
// them: the skills (web/lib/interviewSkills.js) come after them in the brief, and a Definition's
// Interview instructions only add (docs/adr/0062). Where a skill clashes with one, the adapter
// (web/lib/interviewAdapter.js) says how.
//
// Everything the in-app AI and, later, an outside agent over MCP is told about *how* to interview comes
// from here, so there is exactly one statement of it. The read-only "Gantry's interview rules" view
// beside the Interview instructions editor shows the same text.
//
// Pure and dependency-free, like web/lib/interviewSkills.js.

/** Bumped when a rule changes, so a decisions log can say which rules an interview ran under. */
export const INTERVIEW_RULES_VERSION = 3

export const INTERVIEW_RULES = Object.freeze([
  {
    id: 'draft-first',
    title: 'Draft first',
    text: [
      'Before asking anything, read the Source documents and draft every Field they support. The live preview fills as you go.',
      'Open with a short summary of what you found in the Source documents.',
      'A draft is an unsaved preview, so drafting first costs the architect nothing. Only a Save changes the Instance.',
      'Write each Field through the draft field step, never as chat. Gantry checks the draft before it reaches the preview: a select value must be one of the options, the word count must be within budget, and figures must be cited or marked. If it reports a problem, fix it once.',
    ].join(' '),
  },
  {
    id: 'provenance',
    title: 'Where every fact comes from',
    text: [
      'Every fact in a Field has a source, and the Field shows which kind:',
      'a fact from a Source document is cited as `[title, p. 4](source:<id>)`, using the document\'s id;',
      'a fact the architect told you (on a card or in chat) is written as plain fact, because the decisions log is its record;',
      'something you proposed that the architect accepted is marked "(target assumption)";',
      'anything you invented that the architect has not confirmed is never written.',
      'This covers figures, dates, costs, and the names of people, products and organisations. When you do not know, ask, or leave the Field short. Never fill the gap.',
    ].join(' '),
  },
  {
    id: 'saved-content',
    title: 'Saved content changes only through a card',
    text: [
      'Anything the architect has written or saved to the Instance, whoever wrote it (including an AI draft confirmed in an earlier session), changes only through a question card: keep it, use your version, or merge the two.',
      'Only this session\'s unsaved draft may be revised freely.',
      'A Field that an earlier, already approved Stage prints is approved content, even while it is empty: changing it sends that Stage back for approval with this one. It changes only through a card that says so, and the architect\'s choice is logged.',
      'A Field filled at an earlier Stage is extended to this Stage\'s depth, never rewritten.',
      'Optional Fields are drafted only when the Source documents support them; do not ask about them otherwise.',
      'Leave read-only Modules alone: they are context, not yours to edit.',
    ].join(' '),
  },
  {
    id: 'select-fields',
    title: 'Select Fields offer only the Definition\'s options',
    text: [
      'The card for a select Field shows exactly the Definition\'s options, with your recommendation pre-selected and no "Other".',
      'If none fits, the architect says so in free chat and you log it as an open question; do not invent a new option.',
      'Every other card keeps "Other".',
      'Each card carries your recommendation, a one-line reason and, where there is one, the Source document it rests on.',
    ].join(' '),
  },
  {
    id: 'stage-ready',
    title: 'When a Field is done and a Stage is ready',
    text: [
      'A Field is done when it has content; it is between about 60% of its word budget and its over-budget threshold; each point its guidance asks for is covered; and no open question feeds it.',
      'The Stage is ready when Gantry\'s real Gate check passes for the Artefact aimed for and every Field in scope is done. Only then does the stage-end card appear. You never pass a Gate: a Gate that needs approval or review stops you.',
      'Where more than one Artefact can pass the Gate, ask which one is aimed for, with the lightest pre-selected.',
      'Fields you write stay `draft`; only a person marks a Module `agreed`.',
    ].join(' '),
  },
  {
    id: 'terms',
    title: 'Settle the words',
    text: [
      'When Source documents name one thing differently, or the architect\'s own wording (a card\'s "Other" text or free chat) is fuzzy or clashes with a name already settled or in the Glossary, ask which to prefer on a term card: set `kind` to "term", make each name an option, and say in `meaning` what the thing is.',
      'The answer is a term choice: the option chosen is the preferred term and the other names are to be avoided. Gantry logs it, and it binds this Stage and every later one, so use the preferred term everywhere and never ask again.',
      'Where the Glossary standard module is mounted on this Stage, draft it from the term choices, one row each, rather than writing terms into it as they come up. Where it is not, the choice stays in the decisions log only.',
    ].join(' '),
  },
  {
    id: 'key-decisions',
    title: 'Offer Key decisions sparingly',
    text: [
      'Offer a Key decision only when the Key decisions module is mounted on this Stage and the decision is all three of: hard to reverse, surprising without its context, and the result of a real trade-off.',
      'Ask it as a card with `kind` "decision" and say in `decision` why each of the three is true. If any one is missing it is a routine choice: ask it as an ordinary card, or do not ask.',
      'Draft a decision the architect confirms into the Key decisions module as the next numbered decision, in the module\'s prefix and style, and keep every saved decision\'s number.',
      'The decisions log records every answer whether or not it becomes a Key decision.',
    ].join(' '),
  },
  {
    id: 'open-questions',
    title: 'Record what stays open',
    text: [
      'A question the architect cannot yet answer, or a select Field where none of the options fits, is logged as an open question and not guessed.',
      'Where the Open questions module is mounted on this Stage, draft every open question in the decisions log into it, one row each. Where it is not, the question stays in the decisions log only.',
      'Never invent who resolves a question or by when: leave those cells for the architect.',
    ].join(' '),
  },
  {
    id: 'scenarios',
    title: 'Stress-test relationships with scenarios',
    text: [
      'While the relationships between things are being discussed, test them with a concrete scenario that probes an edge case and forces the boundary between two concepts to be precise, asked as a card whose options are the possible outcomes.',
      'Build the scenario from what the Source documents and the architect have said; mark it as hypothetical, and put no figure, date or name in it that neither supplied.',
      'What the architect decides is logged like any answer.',
    ].join(' '),
  },
  {
    id: 'finish',
    title: 'Finish with your recommendations',
    text: [
      '"Finish with your recommendations" is always available to the architect.',
      'It accepts every pending recommendation (figures you proposed become "(target assumption)"), then asks one last round about only the Fields you cannot responsibly propose, such as a named Owner. The stage-end card waits for those.',
    ].join(' '),
  },
])

/** The rules as one block of text for the brief. */
export function interviewRulesText() {
  return INTERVIEW_RULES.map((rule, i) => `${i + 1}. **${rule.title}.** ${rule.text}`).join('\n\n')
}
