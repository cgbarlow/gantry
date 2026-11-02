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
export const INTERVIEW_RULES_VERSION = 1

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
