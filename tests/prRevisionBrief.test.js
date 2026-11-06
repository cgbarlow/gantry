import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateCards, ASK_TOOL } from '../web/lib/aiCards.js'
import { buildInterviewBrief } from '../web/lib/interviewBrief.js'
import { loadInterviewSkills } from '../web/lib/interviewSkills.js'
import { INTERVIEW_RULES, INTERVIEW_RULES_VERSION } from '../web/lib/interviewRules.js'

// #299: what the AI is told about revising a Stage the Owner sent back and about offering to re-open a signed-off Stage.

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

test('Gantry\'s rules say the AI never writes to the Pull Request, and when it may offer to re-open', () => {
  assert.equal(INTERVIEW_RULES_VERSION, 5)
  const byId = Object.fromEntries(INTERVIEW_RULES.map((r) => [r.id, r]))
  assert.match(byId['sent-back'].text, /You never write to the Pull Request: no comments, no replies, no resolved threads/)
  assert.match(byId['sent-back'].text, /keep or redraft each of those Fields/)
  assert.match(byId['re-open'].text, /`kind` "reopen"/)
  assert.match(byId['re-open'].text, /only when the brief lists that Stage as one Gantry would allow/)
})

test('an offer to re-open is a card with a Stage and no options', () => {
  assert.deepEqual(validateCards({ questions: [{ id: 'r', kind: 'reopen', stage: 'scope', question: 'Contradicted.' }] }).cards.map((c) => [c.id, c.kind, c.stage, c.options]), [['r', 'reopen', 'scope', []]])
  const missing = validateCards({ questions: [{ kind: 'reopen', question: 'Contradicted.' }] })
  assert.equal(missing.ok, false)
  assert.match(missing.errors[0], /stage is missing/)
  assert.ok(ASK_TOOL.parameters.properties.questions.items.properties.kind.enum.includes('reopen'))
})

test('the brief lists the signed-off Stages the AI may offer to re-open, and what stops the others', () => {
  const definition = {
    id: 'small',
    stages: [
      { id: 'scope', title: 'Scope', gate: 'g1', modules: ['m1'] },
      { id: 'shape', title: 'Shape', gate: 'g2', modules: ['m2'] },
    ],
    artefacts: [{ id: 'a2', title: 'Shape doc', gate: 'g2', requires: ['m2.body'] }],
    modules: [
      { id: 'm1', title: 'One', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] },
      { id: 'm2', title: 'Two', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] },
    ],
  }
  const brief = (reopenable) => buildInterviewBrief({ definition, stageId: 'shape', artefactId: 'a2', saved: [], sources: [], skills, reopenable }).text
  assert.match(brief([{ id: 'scope', title: 'Scope', allowed: true, blocker: '' }]), /Signed-off Stages[^\n]*\n- Scope \(`scope`\): Gantry would allow it to be re-opened now\./)
  assert.match(brief([{ id: 'scope', title: 'Scope', allowed: false, blocker: 'Shape is already in progress.' }]), /- Scope \(`scope`\): cannot be re-opened now\. Shape is already in progress\./)
  assert.doesNotMatch(brief([]), /Signed-off Stages/)
})
