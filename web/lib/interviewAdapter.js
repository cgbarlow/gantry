// #285 (docs/adr/0065): the **adapter** between the bundled skills and Gantry. `grilling` and
// `domain-modeling` (web/lib/interviewSkills.js) are written for a coding agent in a repository: they
// talk about CONTEXT.md, ADRs, a codebase to look things up in, sub-agents, and acting on a plan.
// Gantry interviews an architect about an Instance, so every one of those words needs a meaning here
// and, where the skill's advice would clash with one of Gantry's fixed rules (web/lib/interviewRules.js),
// the clash needs a settled answer, so the model never has to guess.
//
// Three things live here:
//
//   ADAPTER_MAPPINGS  what each coding-agent term of the skills means in Gantry;
//   ADAPTER_CONFLICTS each known clash between a skill and a Gantry rule, and how Gantry settles it;
//   unmappedSkillTerms  the coverage check: it reads the skills' text, collects the terms that only make
//                     sense in a coding-agent's world, and reports any no mapping covers.
//
// tests/interviewAdapter.test.js runs that check on the bundled files, so moving the pinned skills to
// a newer release fails the build until the adapter has been taught what the new text says. The
// check is deliberately a vocabulary check, not a reading of the whole skill: it catches a new
// file name, path or environment word, which is how a skill grows a new assumption about its world.
//
// Pure and dependency-free, like web/lib/interviewSkills.js.

/**
 * What the skills' terms mean in Gantry. `matches` are tested against each term the coverage check
 * collects (lower-cased words, and file or path tokens as written); `skillTerms` and `gantry` are what
 * the brief shows the model.
 */
export const ADAPTER_MAPPINGS = Object.freeze([
  {
    id: 'context',
    skillTerms: ['CONTEXT.md', 'CONTEXT-MAP.md', 'the glossary / the language'],
    gantry: "the Glossary standard module. There is one glossary per Instance, so there is no context map. Read the Glossary module's saved content and the term choices in the decisions log for the language already settled.",
    matches: [/^(\.\/)?(.*\/)?CONTEXT(-MAP|-FORMAT)?(\.md)?$/],
  },
  {
    id: 'adr',
    skillTerms: ['an ADR', 'docs/adr/', 'ADR-FORMAT.md'],
    gantry: 'a Key decision, in the Key decisions standard module, written in the style the Definition mounted it with. Offer one only when the three-part test passes (hard to reverse, surprising without context, a real trade-off) and the Key decisions module is mounted on this Stage; otherwise the answer stays in the decisions log only.',
    matches: [/^(\.\/)?ADR(-NNNN|-FORMAT)?(\.md)?$/, /^(\.\/)?(docs\/)?adr\/?$/, /^(\.\/)?docs\/?$/, /^\d{4}-[\w.-]+\.md$/],
  },
  {
    id: 'look-up',
    skillTerms: ['look it up yourself', 'dispatch a sub-agent', 'the filesystem and tools', 'the code, the codebase', 'cross-reference with code'],
    gantry: "reading the Source documents (and the Instance's saved content). A fact that is in them is never asked of the architect. Read them yourself; there is no sub-agent to dispatch. Where they disagree with what the architect says, surface the contradiction as a card.",
    matches: [/^sub-?agents?$/, /^file ?system$/, /^tools?$/, /^code(base)?$/, /^terminal$/, /^commits?$/],
  },
  {
    id: 'repository',
    skillTerms: ['repo', 'repository', 'files, directories and folders'],
    gantry: 'the Instance, and its Modules and Fields. Gantry has no files for you to create: content is drafted into Fields.',
    matches: [/^repos?(itor(y|ies))?$/, /^files?$/, /^director(y|ies)$/, /^folders?$/],
  },
  {
    id: 'example-layout',
    skillTerms: ['src/ordering/', 'docs/adr/ trees'],
    gantry: 'only illustrations of a software repository. Nothing in them names a place in Gantry.',
    matches: [/^(\.\/)?(src|ordering|billing|fulfillment)(\/|$)/, /^(\.\/)?src\/[\w/-]+(\/CONTEXT\.md)?$/],
  },
  {
    id: 'ask',
    skillTerms: ['AskUserQuestion', 'number each question and give your recommended answer'],
    gantry: 'question cards (the `ask_architect` tool): two to four options, your recommendation pre-selected, a one-line why, and the Source document it rests on. Never write the skill\'s "Q1 / Q2" text layout in chat.',
    matches: [/^recommended answer$/, /^ask ?user ?question$/],
  },
  {
    id: 'round',
    skillTerms: ['a round', 'the frontier', 'the design tree'],
    gantry: 'a round of question cards: every question whose prerequisites are already settled. The cards show four at a time, with Next and Back, and the round is submitted together. The dependency tree decides what is ready; the priority order only sorts the cards within a round.',
    matches: [/^rounds?$/, /^frontier$/, /^design tree$/],
  },
  {
    id: 'shared-understanding',
    skillTerms: ['shared understanding', 'Do not act on it until the user confirms'],
    gantry: 'the stage-end card. It appears when the Stage is ready (see the rule on when a Stage is ready) and asks the architect to confirm the summary before anything is saved.',
    matches: [/^shared understanding$/],
  },
  {
    id: 'act',
    skillTerms: ['act on it'],
    gantry: 'a Save. Drafting into the live preview is not acting: a draft is an unsaved preview the architect can discard.',
    matches: [/^act on$/],
  },
])

/**
 * The known clashes between a skill and Gantry's fixed rules, and how Gantry settles each. Gantry's
 * rules come first, so every `settled` is the answer the model follows.
 */
export const ADAPTER_CONFLICTS = Object.freeze([
  {
    id: 'draft-first',
    skill: 'Grilling: do not act until the user confirms a shared understanding, and ask before building.',
    settled: 'Draft first. A draft is an unsaved preview, and "acting" means a Save, so drafting before asking is allowed. Only the Save waits for the architect to confirm the stage-end card.',
  },
  {
    id: 'glossary-inline',
    skill: 'Domain modeling: update CONTEXT.md inline, the moment a term is resolved.',
    settled: 'Log the term choice in the decisions log and draft it into the Glossary module at the Stage where the Glossary is mounted. Never write to the Glossary straight away, and never write to saved content except through a card.',
  },
  {
    id: 'adr-file',
    skill: 'Domain modeling: create the docs/adr/ folder and an ADR file when the first one is needed.',
    settled: "A Key decision is a numbered entry in the Key decisions module, drafted like any Field. Where that module isn't mounted on the Stage, don't offer one: the decisions log already records every answer.",
  },
  {
    id: 'whole-frontier',
    skill: 'Grilling: ask the whole frontier in one round, laid out as numbered Q1, Q2 blocks.',
    settled: 'Ask the whole ready set as a round of question cards, shown four at a time and submitted together. Cards, not chat text. Free chat stays open alongside.',
  },
  {
    id: 'sub-agent',
    skill: 'Grilling: dispatch a sub-agent to find a fact, and do not block on it.',
    settled: 'You read the Source documents yourself. If the fact is not in them, it is a missing fact: ask for it as a card, or write nothing. Never invent it.',
  },
  {
    id: 'frontier-empty',
    skill: 'Grilling: the session is done when the frontier is empty.',
    settled: 'A Stage is ready only when Gantry\'s real Gate check passes for the Artefact aimed for and every Field in scope is done. An empty frontier alone does not end it.',
  },
  {
    id: 'other-option',
    skill: 'Grilling: multiple choices may be open-ended.',
    settled: 'A select Field\'s card shows exactly the Definition\'s options, with no "Other". If none fits, the architect says so in free chat and it is logged as an open question.',
  },
  {
    id: 'cross-reference-code',
    skill: 'Domain modeling: cross-reference with code and surface a contradiction.',
    settled: 'Cross-reference with the Source documents and the Instance\'s saved content. Surface a contradiction as a card; never change saved content to match.',
  },
  {
    id: 'terms-from-architect',
    skill: 'Domain modeling: challenge fuzzy or clashing terms.',
    settled: "Do, including the architect's own wording (card \"Other\" text or free chat) and not only Source documents that disagree. Ask which term to prefer on a card. The answer is logged and binds every later Stage.",
  },
])

// --- the coverage check -----------------------------------------------------------------------------------------------

// Words that only make sense in a coding agent's world. Matched case-insensitively, whole word.
const ENVIRONMENT_WORDS = [
  /\bsub-?agents?\b/gi,
  /\bfile ?system\b/gi,
  /\bcode(?:base)?\b/gi,
  /\brepos?(?:itor(?:y|ies))?\b/gi,
  /\b(?:files?|director(?:y|ies)|folders?)\b/gi,
  /\bcommits?\b/gi,
  /\bterminal\b/gi,
  /\btools?\b/gi,
  /\bshared understanding\b/gi,
  /\bact on\b/gi,
  /\bfrontier\b/gi,
  /\brounds?\b/gi,
  /\brecommended answer\b/gi,
  /\bdesign tree\b/gi,
  /\bask ?user ?question\b/gi,
]
// A file name (with an extension that names a file in a project), a path, or an ADR / numbered-record name.
const FILE_TOKEN = /[A-Za-z0-9_.-]+\.(?:md|ya?ml|json|txt|js|ts|toml)\b/g
const PATH_TOKEN = /(?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]*)+/g
const ACRONYM_TOKEN = /\bADR(?:-[A-Z]+)?\b/g
const CONTEXT_TOKEN = /\bCONTEXT(?:-[A-Z]+)?\b/g

/** The terms in `text` that only make sense in a coding agent's world, as a Set: lower-cased words, and file / path tokens as written. */
export function environmentTermsIn(text) {
  const terms = new Set()
  const body = String(text ?? '')
  for (const word of ENVIRONMENT_WORDS) for (const match of body.matchAll(word)) terms.add(match[0].toLowerCase().replace(/\s+/g, ' '))
  for (const pattern of [FILE_TOKEN, PATH_TOKEN, ACRONYM_TOKEN, CONTEXT_TOKEN]) for (const match of body.matchAll(pattern)) terms.add(match[0])
  return terms
}

/**
 * The environment terms in `texts` (a list of strings, or `{ text }` objects) that no mapping covers —
 * empty when the adapter is complete for them. Each is `{ term }`.
 */
export function unmappedSkillTerms(texts, mappings = ADAPTER_MAPPINGS) {
  const uncovered = new Set()
  for (const entry of texts) {
    for (const term of environmentTermsIn(typeof entry === 'string' ? entry : entry?.text)) {
      if (!mappings.some((mapping) => mapping.matches.some((pattern) => pattern.test(term)))) uncovered.add(term)
    }
  }
  return [...uncovered].sort().map((term) => ({ term }))
}

/** Every text of a loaded skills bundle (web/lib/interviewSkills.js `loadInterviewSkills`), for the coverage check. */
export function skillTexts(bundle) {
  return (bundle?.skills ?? []).flatMap((skill) => skill.files.map((file) => file.text))
}

// --- what the brief shows ---------------------------------------------------------------------------------------------

/** The adapter as text for the brief: the mappings, then the known conflicts. */
export function adapterText() {
  const lines = [
    "The skills above are written for a coding agent working in a software repository. You are interviewing an architect about a Gantry Instance. Read them with these meanings, which are Gantry's and take precedence over the skills' own wording.",
    '',
    '### What the skills\' terms mean here',
    '',
  ]
  for (const mapping of ADAPTER_MAPPINGS) lines.push(`- ${mapping.skillTerms.join('; ')} mean ${mapping.gantry}`)
  lines.push('', "### Where a skill and Gantry's rules clash, and how it is settled", '')
  for (const conflict of ADAPTER_CONFLICTS) lines.push(`- ${conflict.skill} Gantry settles it: ${conflict.settled}`)
  return lines.join('\n')
}
