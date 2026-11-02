// #278 (parent #238, docs/adr/0065): question cards. The AI asks the architect questions as cards, and a
// card travels as one `ask_architect` tool call (ADR-0061, research in #241). Gantry never trusts the shape
// the model sends: every card is validated here, whether it arrived as a native tool call or as a fenced
// `gantry-questions` JSON block in the text (the fallback for a model that doesn't use the tool).
//
// This module is pure (no DOM, no network) so the unit tests drive all of it.

export const ASK_TOOL_NAME = 'ask_architect'
export const FALLBACK_FENCE = 'gantry-questions'

export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4

/** The JSON Schema of the `ask_architect` tool's input. A round holds any number of questions (ADR-0065). */
export const ASK_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      description: 'Every question whose prerequisites are settled, asked together as one round.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A short unique id, needed only when another card in the tree waits for this one (see "after").' },
          header: { type: 'string', description: 'A word or two naming the topic, shown as the card’s heading.' },
          question: { type: 'string', description: 'The question itself.' },
          options: {
            type: 'array',
            minItems: MIN_OPTIONS,
            maxItems: MAX_OPTIONS,
            description: `${MIN_OPTIONS} to ${MAX_OPTIONS} distinct choices. Do not add an "Other" option: Gantry always offers one.`,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'A short name for the choice.' },
                description: { type: 'string', description: 'One line on what choosing it means.' },
                draft: { type: 'string', description: 'The text this choice would put in the Field, if it feeds one.' },
              },
              required: ['label'],
            },
          },
          multiSelect: { type: 'boolean', description: 'True when more than one option may be chosen.' },
          recommended: {
            description: 'The label of the option you recommend (an array of labels when multiSelect is true). It must be one of the options.',
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          why: { type: 'string', description: 'One line on why you recommend it.' },
          source: {
            type: 'object',
            description: 'The Source document the recommendation rests on, when there is one.',
            properties: {
              document: { type: 'string', description: 'The Source document’s id, exactly as listed.' },
              location: { type: 'string', description: 'Where in it, for example "p. 11".' },
            },
            required: ['document'],
          },
          field: { type: 'string', description: 'The Field this answer feeds, as module.field, when it feeds one.' },
          after: {
            type: 'array',
            items: { type: 'string' },
            description: 'The ids of cards that must be answered before this one can be asked. Gantry holds the card back until they are, then shows it.',
          },
          kind: {
            type: 'string',
            enum: ['disagreement', 'missing'],
            description: '"disagreement" when Source documents disagree, "missing" when a fact the Stage needs is in none of them. Leave out for any other question. Gantry uses it to order the cards in a round.',
          },
        },
        required: ['question', 'options', 'recommended'],
      },
    },
  },
  required: ['questions'],
}

/** The tool as the model is told about it. */
export const ASK_TOOL = {
  name: ASK_TOOL_NAME,
  description:
    'Ask the architect one round of multiple-choice questions, shown as cards. Each question has 2 to 4 options and ' +
    'a recommendation that is one of them. Use it for every question, instead of asking in prose. ' +
    'The architect’s answers come back as this tool’s result.',
  parameters: ASK_TOOL_SCHEMA,
}

/** What a model without tool calling is told, in place of the tool, so it can still ask cards (the text fallback). */
export const TEXT_FALLBACK_INSTRUCTIONS =
  `To ask the architect questions, write one fenced code block tagged ${FALLBACK_FENCE} containing JSON of the form ` +
  `{"questions":[{"header":"...","question":"...","options":[{"label":"...","description":"..."}],"multiSelect":false,` +
  `"recommended":"<one option label>","why":"...","source":{"document":"<id>","location":"p. 3"}}]}. ` +
  `Each question has ${MIN_OPTIONS} to ${MAX_OPTIONS} options and its recommendation is one of them. ` +
  `"source" is optional, and its document must be one of the listed Source documents. Do not add an "Other" option. ` +
  'Write nothing after the block: the architect answers on the cards.'

function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function sourceKey(value) {
  return str(value).toLowerCase()
}

/**
 * Resolves a cited Source document against the known ones. `knownSources` is an array of ids or of
 * `{ id, title }`. Returns the canonical id, or null when it isn't one of them.
 */
function resolveSource(document, knownSources) {
  const wanted = sourceKey(document)
  for (const known of knownSources) {
    const id = typeof known === 'string' ? known : known?.id
    const title = typeof known === 'string' ? '' : known?.title
    if (sourceKey(id) === wanted || (title && sourceKey(title) === wanted)) return id
  }
  return null
}

/**
 * Checks the input of an `ask_architect` call (or the parsed `gantry-questions` block). Returns
 * `{ ok, cards, errors }`. `errors` are written to be sent back to the model, so each says where the problem
 * is and what to do. `knownSources` (optional) lists the Instance's Source documents; when given, a cited
 * document must be one of them.
 *
 * A card in `cards` is normalised: `{ id, header, question, options: [{label, description, draft}],
 * multiSelect, recommended: [label], why, source: {document, location} | null, field, after?, kind? }`
 * (`after` and `kind` are present only when the model sent them; #287).
 */
export function validateCards(input, { knownSources } = {}) {
  const errors = []
  let questions = input
  if (input && typeof input === 'object' && !Array.isArray(input)) questions = input.questions
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, cards: [], errors: ['Send {"questions": [...]} with at least one question.'] }
  }
  const cards = []
  questions.forEach((q, index) => {
    const at = `questions[${index}]`
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      errors.push(`${at} must be an object with "question", "options" and "recommended".`)
      return
    }
    const before = errors.length
    const question = str(q.question)
    if (!question) errors.push(`${at}.question is missing: write the question.`)

    const rawOptions = Array.isArray(q.options) ? q.options : []
    const options = rawOptions.map((o) => ({
      label: str(typeof o === 'string' ? o : o?.label),
      description: str(typeof o === 'object' ? o?.description : ''),
      draft: str(typeof o === 'object' ? o?.draft : ''),
    }))
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      errors.push(`${at}.options has ${options.length}: give ${MIN_OPTIONS} to ${MAX_OPTIONS} options.`)
    }
    if (options.some((o) => !o.label)) errors.push(`${at}.options: every option needs a "label".`)
    const labels = options.map((o) => o.label.toLowerCase()).filter(Boolean)
    if (new Set(labels).size !== labels.length) errors.push(`${at}.options: the labels must be different from each other.`)

    const multiSelect = q.multiSelect === true
    let recommended = Array.isArray(q.recommended) ? q.recommended.map(str) : [str(q.recommended)]
    recommended = recommended.filter(Boolean)
    if (recommended.length === 0) {
      errors.push(`${at}.recommended is missing: name the option you recommend.`)
    } else {
      const unknown = recommended.filter((r) => !options.some((o) => o.label.toLowerCase() === r.toLowerCase()))
      if (unknown.length) {
        errors.push(`${at}.recommended "${unknown[0]}" is not one of the options. It must match an option's label exactly.`)
      } else if (!multiSelect && recommended.length > 1) {
        errors.push(`${at}.recommended names ${recommended.length} options but multiSelect is not true: recommend one, or set multiSelect.`)
      } else {
        // Use the option's own spelling.
        recommended = recommended.map((r) => options.find((o) => o.label.toLowerCase() === r.toLowerCase()).label)
      }
    }

    const after = (Array.isArray(q.after) ? q.after : q.after ? [q.after] : []).map(str).filter(Boolean)
    const kind = ['disagreement', 'missing'].includes(str(q.kind).toLowerCase()) ? str(q.kind).toLowerCase() : ''

    let source = null
    if (q.source !== undefined && q.source !== null && q.source !== '') {
      const document = str(typeof q.source === 'string' ? q.source : q.source?.document)
      const location = str(typeof q.source === 'object' ? q.source?.location : '')
      if (!document) {
        errors.push(`${at}.source needs a "document": the id of a Source document.`)
      } else if (knownSources) {
        const id = resolveSource(document, knownSources)
        if (id === null) errors.push(`${at}.source "${document}" is not one of this Instance's Source documents. Cite one that is listed, or leave source out.`)
        else source = { document: id, location }
      } else {
        source = { document, location }
      }
    }

    if (errors.length === before) {
      cards.push({
        id: str(q.id) || `q-${cards.length + 1}`,
        header: str(q.header),
        question,
        options,
        multiSelect,
        recommended,
        why: str(q.why),
        source,
        field: str(q.field) || null,
        ...(after.length ? { after } : {}),
        ...(kind ? { kind } : {}),
      })
    }
  })
  return { ok: errors.length === 0, cards: errors.length === 0 ? cards : [], errors }
}

const FENCE = new RegExp('```[ \\t]*' + FALLBACK_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g')

/** Removes the fallback block from text meant for the screen, including one still being written (no closing fence yet). */
export function stripQuestionBlock(text) {
  const closed = String(text ?? '').replace(FENCE, '')
  const open = closed.search(new RegExp('```[ \\t]*' + FALLBACK_FENCE))
  return (open === -1 ? closed : closed.slice(0, open)).trim()
}

/** True once the text has started a fallback block. */
export function startsQuestionBlock(text) {
  return new RegExp('```[ \\t]*' + FALLBACK_FENCE).test(String(text ?? ''))
}

/**
 * Looks for fallback blocks in the model's text. Returns `{ found, questions, text, parseError }`: `questions`
 * is every question from every parseable block (not yet validated), `text` is what is left to show as chat.
 */
export function extractQuestionBlocks(text) {
  const source = String(text ?? '')
  const questions = []
  let found = false
  let parseError = null
  for (const match of source.matchAll(FENCE)) {
    found = true
    try {
      const parsed = JSON.parse(match[1])
      const list = Array.isArray(parsed) ? parsed : parsed?.questions
      if (Array.isArray(list)) questions.push(...list)
      else parseError = parseError ?? 'The block has no "questions" list.'
    } catch (err) {
      parseError = parseError ?? `The block is not valid JSON (${err.message}).`
    }
  }
  return { found, questions, text: source.replace(FENCE, '').trim(), parseError }
}

/**
 * Decides what a finished turn is. `toolCalls` are the model's completed tool calls (`{id, name, input}`), `text`
 * what it wrote. Returns one of:
 *   { kind: 'cards', via: 'native' | 'text', cards, text, calls }   a valid round of cards
 *   { kind: 'invalid', via: 'native', errors, results, text }       an ask_architect call that failed validation;
 *                                                                   `results` answers each call for the retry
 *   { kind: 'chat', text, parseError? }                             nothing usable: show the text as chat
 * A native call wins over a fenced block; a fenced block that doesn't parse or validate is just chat.
 */
export function interpretTurn({ text = '', toolCalls = [] }, { knownSources } = {}) {
  const asks = toolCalls.filter((c) => c.name === ASK_TOOL_NAME)
  if (asks.length) {
    const checked = asks.map((call) => ({
      call,
      ...(call.input === null || call.input === undefined || call.invalid
        ? { ok: false, cards: [], errors: [call.invalid ?? 'The arguments were not valid JSON.'] }
        : validateCards(call.input, { knownSources })),
    }))
    if (checked.every((c) => c.ok)) {
      return { kind: 'cards', via: 'native', cards: checked.flatMap((c) => c.cards), text: text.trim(), calls: asks }
    }
    const anyBad = checked.filter((c) => !c.ok)
    const errors = anyBad.flatMap((c) => c.errors)
    const results = checked.map((c) => ({
      toolCallId: c.call.id,
      name: ASK_TOOL_NAME,
      isError: true,
      content: c.ok
        ? 'Not shown: another ask_architect call in the same turn was invalid. Send all of the questions again in one call.'
        : `The question card was not shown because it was invalid:\n- ${c.errors.join('\n- ')}\nSend the corrected ask_architect call.`,
    }))
    return { kind: 'invalid', via: 'native', errors, results, text: text.trim() }
  }
  const block = extractQuestionBlocks(text)
  if (block.found && block.questions.length) {
    const checked = validateCards({ questions: block.questions }, { knownSources })
    if (checked.ok) return { kind: 'cards', via: 'text', cards: checked.cards, text: block.text, calls: [] }
    return { kind: 'chat', text: text.trim(), invalidBlock: checked.errors }
  }
  return { kind: 'chat', text: text.trim(), ...(block.found ? { invalidBlock: [block.parseError ?? 'The block had no questions.'] } : {}) }
}
