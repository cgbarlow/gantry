// #310 (map #238): the example's decisions logs, one for each Stage (`interview/<stageId>.yaml`). They are made with the very code a Save
// uses (web/lib/interviewLog.js builds the entries, web/lib/decisionsLog.js writes the file), so each one is a file the app could have
// written, and a fingerprint is what the app would have recorded. The story they tell is fictitious, as everything in the pack is, and
// no AI Provider was used: the status lines name no model.
import { loadDefinitionForInstance, readInstance, readModule } from '../../lib/instance.js'
import { applyDecisionsDelta, emptyDecisionsLog, serializeDecisionsLog } from '../../web/lib/decisionsLog.js'
import { createSessionLog } from '../../web/lib/interviewLog.js'
import { reviewEntriesFor } from '../../web/lib/reviewRound.js'
import { returnedToDraftNote } from '../../web/lib/bringUpToDate.js'
import { fingerprintText } from '../../web/lib/sourceDocuments.js'

const WHO = 'p.natarajan'

const asText = (value) => (Array.isArray(value) ? value.join('\n') : String(value ?? '')).trim()

/**
 * @param {object} input
 * @param {string} input.instancesDir  the workspace folder holding the Instance
 * @param {string} input.slug
 * @param {{ entries: object[], texts: Record<string, string> }} input.sources  the pack's manifest entries and the text read from each, by id
 * @param {object} input.reviewed  `buildReviewedCopy`'s result
 * @returns {Record<string, string>}  the YAML of each Stage's log, by Stage id
 */
export function buildDecisionsLogs({ instancesDir, slug, sources, reviewed }) {
  // #359: the logs are built on the version the example is pinned to, and name it as the interview's instructions the way a Save on
  // that Instance records them (`design@4` since #359), so a rebuild never describes the example on a version it does not run on.
  const definition = loadDefinitionForInstance(readInstance(slug, { instancesDir }))
  const instructions = `${definition.id}@${definition.version}`
  const saved = {}
  for (const moduleId of definition.modules.keys()) {
    try {
      saved[moduleId] = readModule(definition, slug, moduleId, { instancesDir })
    } catch {
      // A Module the Instance does not hold.
    }
  }
  const valueOf = (key) => {
    const [moduleId, ...rest] = key.split('.')
    return saved[moduleId]?.fields?.[rest.join('.')]
  }
  const moduleTitle = (moduleId) => definition.modules.get(moduleId)?.title ?? moduleId
  const fieldTitle = (key) => {
    const [moduleId, ...rest] = key.split('.')
    const spec = definition.modules.get(moduleId)
    const field = spec?.fields.find((f) => f.id === rest.join('.'))
    return spec && field ? `${spec.title} · ${field.title}` : key
  }
  const titleOf = new Map(sources.entries.map((e) => [e.id, e.title]))

  // What a Field's draft record lists as its inputs: a Source document (with the page or sheet it was read from) or another Field.
  const fromSource = (id, range) => ({ source: id, title: titleOf.get(id), ...(range ? { range } : {}), fingerprint: sources.texts[id] ? fingerprintText(sources.texts[id]) : null })
  const fromField = (key) => {
    const value = valueOf(key)
    if (value === undefined) throw new Error(`The example holds no Field ${key}.`)
    return { field: key, title: fieldTitle(key), fingerprint: fingerprintText(asText(value)) }
  }

  const logs = {}

  // One interview session on one Stage: a clock the script moves, the real session log, and each Save written the way the app writes it.
  function session(stageId, { id, artefact, artefactTitle, candidates }) {
    let clock = ''
    const log = createSessionLog({ stageId, now: () => clock, newSessionId: () => id, who: () => WHO })
    let file = emptyDecisionsLog(stageId)
    const draftedKeys = new Set()
    const inputs = {}
    const api = {
      at(time) {
        clock = time
        return api
      },
      log,
      /** What the Fields drafted so far were drafted from. */
      drafted(key, list = []) {
        draftedKeys.add(key)
        inputs[key] = list
      },
      round: 0,
      card({ id: cardId, header, question, options, recommended, why, source, field, kind, decision, meaning }) {
        return { id: cardId, header, question, options: options.map((label) => ({ label })), recommended: [recommended ?? options[0]], why, source: source ?? null, field, ...(kind ? { kind } : {}), ...(decision ? { decision } : {}), ...(meaning ? { meaning } : {}) }
      },
      answer(card, answers, { words, followed = true, round } = {}) {
        log.addAnswer(card, { round: round ?? api.round, words, answers, followed })
      },
      /** A Save: the delta the app would send, applied to the file. */
      save(state = 'saved', { target = stageId, stages, keys = [...draftedKeys] } = {}) {
        const delta = log.delta({ fieldInputs: inputs, fieldKeys: keys, saving: true, status: { who: WHO, target, state, artefact, instructions, ...(stages ? { stages } : {}) } })
        file = applyDecisionsDelta(file, delta, stageId)
        log.commit(delta)
        logs[stageId] = serializeDecisionsLog(file)
      },
    }
    return { api, artefactEntry: () => log.addArtefact({ artefact, title: artefactTitle, candidates }) }
  }

  // ---------------------------------------------------------------------------------------------------------------- SOAP
  {
    const { api, artefactEntry } = session('shape', { id: 'kcm-shape-1', artefact: 'soap-full', artefactTitle: 'Full Solution on a Page', candidates: ['soap', 'soap-full'] })
    api.at('2026-03-17T09:41:00.000Z')
    artefactEntry()

    api.round = 1
    api.at('2026-03-17T09:52:00.000Z')
    api.answer(
      api.card({
        id: 'c1',
        header: 'Problem',
        question: 'How long does a straightforward claim take today?',
        options: ['Median 12.4 working days, from the Client brief', 'A different figure'],
        why: 'The Client brief gives the median and the five-day expectation on page 1. The screen shows where the time goes: the claim is keyed four times.',
        source: { document: 'client-brief', location: 'p. 1' },
        field: 'background.problem',
      }),
      ['Median 12.4 working days, from the Client brief']
    )
    api.at('2026-03-17T09:56:00.000Z')
    api.answer(
      api.card({
        id: 'c2',
        header: 'Success criteria',
        question: 'Which targets does the business case commit to?',
        options: ['The four targets in the Client brief', 'Only payment time and the re-key rate'],
        why: 'They are the sponsor’s own targets, stated on page 2 of the Client brief.',
        source: { document: 'client-brief', location: 'p. 2' },
        field: 'background.success-criteria',
      }),
      ['The four targets in the Client brief'],
      { words: 'All four. The fraud referral rate and the audit trail are what Internal Audit will check first.' }
    )
    api.at('2026-03-17T10:03:00.000Z')
    api.log.addFact('Keep this an integration and process change first. The mainframe stays; people just stop keying into it.', ['introduction.overview'])

    api.round = 2
    api.at('2026-03-17T10:20:00.000Z')
    api.answer(
      api.card({
        id: 'c3',
        header: 'Assumptions',
        question: 'Can Mainframe Integration expose two CICS services in each monthly window?',
        options: ['Yes, two in each window', 'Fewer than two'],
        why: 'Derek Fong said so at the workshop, which is what makes the first two transactions ready for increment 1.',
        source: { document: 'design-workshop-notes' },
        field: 'design-basis.assumptions',
      }),
      ['Yes, two in each window']
    )
    api.at('2026-03-17T10:31:00.000Z')
    api.log.addOpenQuestion({
      question: 'Does the BIBIT contract variation keep current transaction pricing for claims payment?',
      why: 'Treasury has not confirmed it, and it decides whether increment 3 stays within budget.',
      fields: ['dependencies.dependencies-overview'],
    })
    api.log.addOpenQuestion({
      question: 'Can both the April and May mainframe windows be used, given the Finance year-end freeze?',
      why: 'Derek Fong has to book them; increment 1 needs both.',
      fields: ['dependencies.dependencies-overview'],
    })
    api.at('2026-03-17T10:44:00.000Z')
    api.log.addSavedContent('team-and-estimates.estimates', 'keep')

    api.drafted('background.problem', [fromSource('client-brief', 'p. 1'), fromSource('claim-registration-screen')])
    api.drafted('background.success-criteria', [fromSource('client-brief', 'p. 2')])
    api.drafted('design-basis.constraints', [fromSource('client-brief', 'p. 2')])
    api.drafted('design-basis.assumptions', [fromSource('design-workshop-notes')])
    api.drafted('introduction.overview', [])
    api.drafted('dependencies.dependencies-overview', [fromSource('design-workshop-notes')])
    api.at('2026-03-17T11:18:00.000Z')
    api.save()

    // The Reviewed copy came back a week later, and four comments were answered.
    const { id: copyId, name: copyName, read, fieldOf } = reviewed
    const labels = new Map([[read.threads[0].author, 'Reviewer 1'], [read.threads[1].author, 'Reviewer 2']])
    const thread = (index) => read.threads[index]
    const side = (index, { withChanges = false } = {}) => {
      const t = thread(index)
      const changes = (withChanges ? read.changes.filter((c) => c.author === t.author && c.paragraph === t.paragraph) : []).map((c) => ({ kind: c.kind, author: c.author, date: c.date, text: c.text, paragraph: c.paragraph, order: c.order }))
      return {
        key: `${copyId}:${t.id}`,
        author: t.author,
        label: labels.get(t.author),
        thread: { id: t.id, author: t.author, date: t.date, text: t.text, resolved: false, anchor: t.anchor.text, replies: [] },
        changes,
      }
    }
    const answerThread = (index, outcome, { words, openedQuestion = '', withChanges = false } = {}) => {
      const s = side(index, { withChanges })
      const field = fieldOf.get(thread(index).id)
      const result = { card: { review: { copy: { id: copyId, name: copyName }, sides: [s], field, changed: false, unitKind: 'thread' } }, outcome, ...(words ? { words } : {}) }
      return { result, entry: reviewEntriesFor(result, { stage: 'shape', openedQuestion })[0], field }
    }

    api.round = 3
    // 1. "Where does the 12.4 days come from?" The Field is revised to say so.
    api.at('2026-03-25T09:12:00.000Z')
    {
      const { entry } = answerThread(0, 'revise', { words: 'It is the figure in the Client brief. Cite it.' })
      api.log.addReviewAnswered(entry)
    }
    // 2. A date for the retention rules, offered as a tracked insertion, accepted as it stands.
    api.at('2026-03-25T09:20:00.000Z')
    {
      const { entry } = answerThread(2, 'accept', { withChanges: true })
      api.log.addReviewAnswered(entry)
    }
    // 3. Is Treasury's sign-off in the Payments size? Left as it is, with the reason.
    api.at('2026-03-25T09:31:00.000Z')
    {
      const { entry } = answerThread(3, 'keep', { words: 'Sized on the Delivery Office T-shirt scale. Treasury’s sign-off adds elapsed time, not effort, so M stands.' })
      api.log.addReviewAnswered(entry)
    }
    // 4. When will the sandbox be ready? Nobody can say yet, so it becomes an open question.
    api.at('2026-03-25T09:40:00.000Z')
    {
      const draft = answerThread(1, 'cant-settle')
      // The architect's wording for the open question, short enough for the Open questions table; the real names stay out of it.
      const question = 'Review comment (Reviewer 2): when will the bank’s payment API sandbox be ready?'
      const { entry } = answerThread(1, 'cant-settle', { openedQuestion: question })
      api.log.addOpenQuestion({ question, why: 'A reviewer’s comment that could not be settled yet.', fields: [draft.field] })
      api.log.addReviewAnswered(entry)
    }
    // Two agreed Modules went back to draft with the changes, and were agreed again by a person afterwards.
    api.at('2026-03-25T09:44:00.000Z')
    api.log.addReturnedToDraft({
      module: 'background',
      fields: ['background.problem'],
      note: returnedToDraftNote({ moduleTitle: moduleTitle('background'), fieldTitles: [fieldTitle('background.problem')], cause: 'because a reviewer’s comment was answered' }),
    })
    api.log.addReturnedToDraft({
      module: 'dependencies',
      fields: ['dependencies.dependencies-overview'],
      note: returnedToDraftNote({ moduleTitle: moduleTitle('dependencies'), fieldTitles: [fieldTitle('dependencies.dependencies-overview')], cause: 'because a reviewer’s edit was accepted' }),
    })
    api.drafted('background.problem', [fromSource('client-brief', 'p. 1'), fromSource('claim-registration-screen')])
    api.drafted('dependencies.dependencies-overview', [fromSource('design-workshop-notes')])
    api.at('2026-03-25T09:52:00.000Z')
    api.save('saved', { keys: ['background.problem', 'dependencies.dependencies-overview'] })
  }

  // ------------------------------------------------------------------------------------------------------ High-level design
  {
    const { api, artefactEntry } = session('hld-define', { id: 'kcm-hld-1', artefact: 'hld', artefactTitle: 'High-Level Design', candidates: ['hld'] })
    api.at('2026-04-14T13:02:00.000Z')
    artefactEntry()
    api.round = 1
    api.at('2026-04-14T13:15:00.000Z')
    api.answer(
      api.card({
        id: 'c1',
        header: 'Capacity',
        question: 'What sizes the shared services?',
        options: ['Five times the peak day (target assumption)', 'The yearly volume'],
        why: 'The Requirements register gives 600 claims a day after a weather event; the headroom is a target, not a measurement, so it is marked as one.',
        source: { document: 'requirements-register', location: 'Volumes and targets' },
        field: 'nfrs.scalability-and-capacity',
      }),
      ['Five times the peak day (target assumption)']
    )
    api.at('2026-04-14T13:28:00.000Z')
    api.answer(
      api.card({
        id: 'c2',
        header: 'Risk owner',
        question: 'Who owns R4, documents migrated past their retention period, until Records Management confirms the rules?',
        options: ['Karen Doyle, marked interim', 'Priya Natarajan'],
        why: 'The owner of a risk is the person who can act on it, and an owner who has not agreed yet is marked (interim).',
        field: 'risks.risk-register',
      }),
      ['Karen Doyle, marked interim']
    )
    api.at('2026-04-14T13:41:00.000Z')
    api.answer(
      api.card({
        id: 'c3',
        header: 'Alternatives',
        question: 'Why is a dedicated claims product deferred, not rejected?',
        options: ['It needs the same integrations plus a licence, and adds about two quarters', 'Its cost alone'],
        why: 'It stays an option if the CRM System’s workflow extension proves limiting (R3).',
        field: 'alternatives-considered.alternatives',
      }),
      ['It needs the same integrations plus a licence, and adds about two quarters']
    )
    api.at('2026-04-14T13:52:00.000Z')
    api.log.addOpenQuestion({
      question: 'Are liability claims routed to senior handlers by default, or only above a threshold?',
      why: 'Hana Te Rangi decides; it sets the routing rules for increment 2.',
      fields: ['risks.open-issues'],
    })
    api.log.addOpenQuestion({
      question: 'Does the claims data mart feed need its own privacy impact assessment?',
      why: 'The Privacy Office has to answer before the HLD is submitted.',
      fields: ['risks.open-issues'],
    })
    api.drafted('nfrs.scalability-and-capacity', [fromSource('requirements-register', 'Volumes and targets')])
    api.drafted('risks.risk-register', [fromSource('design-workshop-notes')])
    api.drafted('alternatives-considered.alternatives', [fromField('solution-definition.alternatives-sketch')])
    api.at('2026-04-14T14:10:00.000Z')
    api.save()
  }

  // ---------------------------------------------------------------------------------------------------------- Detailed design
  {
    const { api, artefactEntry } = session('detailed-design', { id: 'kcm-dd-1', artefact: 'sad', artefactTitle: 'Solution Architecture Document', candidates: ['sad', 'ssad'] })
    api.at('2026-06-02T09:20:00.000Z')
    artefactEntry()
    api.round = 1
    api.at('2026-06-02T09:35:00.000Z')
    api.log.addTerm(
      api.card({
        id: 't1',
        header: 'Name',
        question: 'Which name do the documents use for the payment service?',
        options: ['BIBIT gateway', 'Payment provider', 'Bibit'],
        why: 'The BIBIT contract and the Treasury team both use "BIBIT gateway".',
        field: 'glossary.terms',
        kind: 'term',
        meaning: 'The third-party payment gateway for premium collection and claims payment',
      }),
      { round: 1, choice: { preferred: 'BIBIT gateway', avoid: ['Payment provider', 'Bibit'], meaning: 'The third-party payment gateway for premium collection and claims payment' }, followed: true, fields: ['glossary.terms'] }
    )
    api.at('2026-06-02T09:38:00.000Z')
    api.log.addTerm(
      api.card({
        id: 't2',
        header: 'Name',
        question: 'Which name do the documents use for the shared customer service?',
        options: ['CIS', 'Customer Master', 'Customer hub'],
        why: 'CIS is the name on the architecture diagrams, and the Glossary already carries it.',
        field: 'glossary.terms',
        kind: 'term',
        meaning: 'Customer Information Service: the new shared service for customer, contact and policy-summary data',
      }),
      { round: 1, choice: { preferred: 'CIS', avoid: ['Customer Master', 'Customer hub'], meaning: 'Customer Information Service: the new shared service for customer, contact and policy-summary data' }, followed: true, fields: ['glossary.terms'] }
    )
    api.round = 2
    api.at('2026-06-02T10:05:00.000Z')
    api.answer(
      api.card({
        id: 'd1',
        header: 'Shared services',
        question: 'Do applications share customer and claim data through services, or copy it?',
        options: ['Shared services (CIS and Claims InfoServ)', 'Point-to-point copies'],
        why: 'The workshop settled it, and it is the decision most other decisions rest on.',
        source: { document: 'design-workshop-notes' },
        field: 'key-decisions.decisions',
        kind: 'decision',
        decision: { hardToReverse: 'Every application would have to be rebuilt to change it.', surprising: 'Point-to-point looks quicker for one application.', tradeOff: 'Every application depends on two new services.' },
      }),
      ['Shared services (CIS and Claims InfoServ)']
    )
    api.at('2026-06-02T10:12:00.000Z')
    api.answer(
      api.card({
        id: 'd2',
        header: 'System of record',
        question: 'Does Policy Data Management stay the system of record?',
        options: ['Yes, behind four CICS transactions (PDM-01 to PDM-04)', 'Move it off the mainframe first'],
        why: 'Moving it is the largest and least certain piece of work on the roadmap, and would defer the benefit by at least eighteen months.',
        source: { document: 'design-workshop-notes' },
        field: 'key-decisions.decisions',
        kind: 'decision',
        decision: { hardToReverse: 'Services built on the transactions assume the mainframe stays.', surprising: 'The mainframe is what makes the process slow.', tradeOff: 'Delivery follows the mainframe change windows.' },
      }),
      ['Yes, behind four CICS transactions (PDM-01 to PDM-04)'],
      { words: 'Keep it. We are changing how people work, not where the policies live.' }
    )
    api.at('2026-06-02T10:30:00.000Z')
    api.log.addOpenQuestion({
      question: 'Are documents for claims closed beyond their retention period migrated or disposed of?',
      why: 'Records Management has to confirm the retention rules before the migration is designed.',
      fields: ['risks.risk-register'],
    })
    api.drafted('glossary.terms', [])
    api.drafted('key-decisions.decisions', [fromSource('design-workshop-notes'), fromField('solution-definition.high-level-solution-overview')])
    api.at('2026-06-02T11:02:00.000Z')
    api.save()
  }

  // ----------------------------------------------------------------------------------------------------- Operational handover
  {
    const { api, artefactEntry } = session('handover', { id: 'kcm-ho-1', artefact: 'as-built', artefactTitle: 'As-Built Document', candidates: ['as-built'] })
    api.at('2026-10-06T08:55:00.000Z')
    artefactEntry()
    api.round = 1
    api.at('2026-10-06T09:10:00.000Z')
    api.log.addFact('In UAT a claim was accepted on a policy that had just changed, because CIS held the lookup for 15 minutes. We cut the cache to 5.', ['key-decisions.decisions', 'as-built-notes.changes-from-design'])
    api.at('2026-10-06T09:18:00.000Z')
    api.answer(
      api.card({
        id: 'd1',
        header: 'Cache',
        question: 'Is the policy-lookup cache change a new Key decision, or a change to AD02?',
        options: ['A new decision, AD08, that relates to AD02', 'Rewrite AD02'],
        why: 'A decision made during the build takes the next number; the design-time one is kept as it was written.',
        field: 'key-decisions.decisions',
        kind: 'decision',
        decision: { hardToReverse: 'Support will rely on the figure in runbooks.', surprising: 'Design said 15 minutes.', tradeOff: 'More calls reach Policy Data Management.' },
      }),
      ['A new decision, AD08, that relates to AD02']
    )
    api.at('2026-10-06T09:30:00.000Z')
    api.log.addSavedContent('as-built-notes.changes-from-design', 'merge')
    api.drafted('key-decisions.decisions', [fromField('architecture.logical-components')])
    api.drafted('as-built-notes.changes-from-design', [fromField('key-decisions.decisions')])
    api.at('2026-10-06T10:02:00.000Z')
    api.save()
  }

  return logs
}
