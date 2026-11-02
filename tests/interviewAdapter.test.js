import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadInterviewSkills } from '../web/lib/interviewSkills.js'
import { ADAPTER_MAPPINGS, ADAPTER_CONFLICTS, adapterText, environmentTermsIn, skillTexts, unmappedSkillTerms } from '../web/lib/interviewAdapter.js'

// #285 (docs/adr/0065): the adapter maps the coding-agent terms of the bundled skills onto Gantry's, and
// lists each known clash with a Gantry rule. This is the adapter-coverage test: moving the pinned skills
// to a newer release fails here until the adapter has been taught any term the new text uses.

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))

describe('adapter coverage', () => {
  test('every coding-agent term the bundled skills use is mapped', () => {
    const uncovered = unmappedSkillTerms(skillTexts(skills))
    assert.deepEqual(uncovered, [], `The bundled skills use terms the adapter (web/lib/interviewAdapter.js) does not map: ${uncovered.map((u) => u.term).join(', ')}`)
  })

  test('the check does see the skills\' terms (it is not passing by finding nothing)', () => {
    const terms = new Set(skillTexts(skills).flatMap((text) => [...environmentTermsIn(text)]))
    for (const expected of ['CONTEXT.md', 'CONTEXT-MAP.md', 'ADR', 'docs/adr/', 'sub-agent', 'filesystem', 'codebase', 'shared understanding', 'act on', 'frontier']) {
      assert.ok(terms.has(expected), `finds "${expected}"`)
    }
    assert.ok(terms.size >= 20, `found ${terms.size} terms`)
  })

  test('fails when a skill uses a term the adapter does not map', () => {
    const grown = [...skillTexts(skills), 'Read CLAUDE.md first, then run the tests in the terminal and open a pull request.', 'Update docs/guides/overview.md']
    const uncovered = unmappedSkillTerms(grown).map((u) => u.term)
    assert.ok(uncovered.includes('CLAUDE.md'), uncovered.join(', '))
    assert.ok(uncovered.includes('docs/guides/overview.md'), uncovered.join(', '))
    assert.ok(!uncovered.includes('terminal'), 'a term that is mapped stays covered')
  })

  test('fails when a mapping is removed', () => {
    const without = ADAPTER_MAPPINGS.filter((m) => m.id !== 'adr')
    const uncovered = unmappedSkillTerms(skillTexts(skills), without).map((u) => u.term)
    assert.ok(uncovered.includes('ADR'), uncovered.join(', '))
  })

  test('accepts plain strings and { text } objects', () => {
    assert.deepEqual(unmappedSkillTerms(['nothing to see here']), [])
    assert.deepEqual(unmappedSkillTerms([{ text: 'see CLAUDE.md' }]), [{ term: 'CLAUDE.md' }])
  })
})

describe('the adapter', () => {
  test('maps the five terms the ticket names', () => {
    const text = adapterText()
    assert.match(text, /CONTEXT\.md[^\n]*Glossary standard module/)
    assert.match(text, /an ADR[^\n]*Key decision/)
    assert.match(text, /look it up yourself[^\n]*reading the Source documents/)
    assert.match(text, /AskUserQuestion[^\n]*question cards/)
    assert.match(text, /shared understanding[^\n]*stage-end card/)
  })

  test('settles drafting first and logging term choices, the two examples ADR-0065 gives', () => {
    const ids = ADAPTER_CONFLICTS.map((c) => c.id)
    assert.ok(ids.includes('draft-first') && ids.includes('glossary-inline'))
    const text = adapterText()
    assert.match(text, /a draft is an unsaved preview, and "acting" means a Save/i)
    assert.match(text, /Log the term choice in the decisions log and draft it into the Glossary module/)
  })

  test('every mapping and conflict is complete', () => {
    for (const mapping of ADAPTER_MAPPINGS) {
      assert.ok(mapping.id && mapping.skillTerms.length && mapping.gantry && mapping.matches.length, mapping.id)
    }
    for (const conflict of ADAPTER_CONFLICTS) assert.ok(conflict.id && conflict.skill && conflict.settled, conflict.id)
    assert.equal(new Set(ADAPTER_MAPPINGS.map((m) => m.id)).size, ADAPTER_MAPPINGS.length)
    assert.equal(new Set(ADAPTER_CONFLICTS.map((c) => c.id)).size, ADAPTER_CONFLICTS.length)
  })
})
