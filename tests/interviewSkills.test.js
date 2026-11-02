import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  INTERVIEW_SKILLS,
  INTERVIEW_SKILLS_URL,
  interviewSkillVersions,
  interviewSkillsCredit,
  loadInterviewSkills,
  loadInterviewSkillsInBrowser,
} from '../web/lib/interviewSkills.js'
import { INTERVIEW_RULES, interviewRulesText } from '../web/lib/interviewRules.js'

// #285 (docs/adr/0065): `grilling` and `domain-modeling` ship unchanged, at a pinned version, with their
// MIT licence and credit. "Unchanged" is checked here by hash, so editing a bundled file (or replacing it
// with a newer release without updating the pin) fails the build.

const DIR = new URL('../web/interview-skills/', import.meta.url)
const sha256 = (path) => createHash('sha256').update(readFileSync(new URL(path, DIR))).digest('hex')

describe('the bundled skills', () => {
  test('are exactly the pinned release (every file matches its recorded hash)', () => {
    for (const skill of INTERVIEW_SKILLS.skills) {
      for (const file of skill.files) assert.equal(sha256(file.path), file.sha256, `${file.path} is unchanged`)
    }
  })

  test('are the two skills ADR-0065 names, and only those', () => {
    assert.deepEqual(INTERVIEW_SKILLS.skills.map((s) => s.id), ['grilling', 'domain-modeling'])
  })

  test('are pinned to a release and a commit', () => {
    assert.match(INTERVIEW_SKILLS.version, /^\d+\.\d+\.\d+$/)
    assert.match(INTERVIEW_SKILLS.commit, /^[0-9a-f]{40}$/)
    assert.equal(INTERVIEW_SKILLS.source, 'https://github.com/mattpocock/skills')
  })

  test('ship with their MIT licence and credit', () => {
    assert.equal(sha256(INTERVIEW_SKILLS.licence.file), INTERVIEW_SKILLS.licence.sha256)
    const licence = readFileSync(new URL(INTERVIEW_SKILLS.licence.file, DIR), 'utf8')
    assert.match(licence, /^MIT License/)
    assert.ok(licence.includes(INTERVIEW_SKILLS.licence.notice))
    assert.match(interviewSkillsCredit(), /Matt Pocock/)
    assert.match(interviewSkillsCredit(), /MIT/)
    assert.match(interviewSkillsCredit(), new RegExp(INTERVIEW_SKILLS.version.replace(/\./g, '\\.')))
  })

  test('report their versions for the rules view and a decisions log', () => {
    const versions = interviewSkillVersions()
    assert.equal(versions.version, INTERVIEW_SKILLS.version)
    assert.deepEqual(versions.skills.map((s) => `${s.id}@${s.version}`), [`grilling@${INTERVIEW_SKILLS.version}`, `domain-modeling@${INTERVIEW_SKILLS.version}`])
  })
})

describe('loading the skills', () => {
  const read = (path) => readFileSync(new URL(path, DIR), 'utf8')

  test('reads every file and the licence', async () => {
    const loaded = await loadInterviewSkills(read)
    assert.deepEqual(loaded.skills.map((s) => s.files.map((f) => f.path)), [['grilling/SKILL.md'], ['domain-modeling/SKILL.md', 'domain-modeling/CONTEXT-FORMAT.md', 'domain-modeling/ADR-FORMAT.md']])
    assert.match(loaded.skills[0].files[0].text, /Interview the user relentlessly/)
    assert.match(loaded.licence, /MIT License/)
    assert.equal(loaded.version, INTERVIEW_SKILLS.version)
  })

  test('names the file it could not read, rather than interviewing with no skills', async () => {
    await assert.rejects(loadInterviewSkills(() => { throw new Error('boom') }), /"grilling\/SKILL\.md" could not be read: boom/)
    await assert.rejects(loadInterviewSkills(() => ''), /"grilling\/SKILL\.md" is empty/)
  })

  test('the browser loader fetches from where the web app serves the files', async () => {
    const urls = []
    const fetchImpl = async (url) => {
      urls.push(url)
      return { ok: true, text: async () => read(url.slice(INTERVIEW_SKILLS_URL.length + 1)) }
    }
    const loaded = await loadInterviewSkillsInBrowser(fetchImpl)
    assert.ok(urls.includes('/interview-skills/grilling/SKILL.md'))
    assert.ok(urls.includes('/interview-skills/LICENSE'))
    assert.equal(loaded.skills.length, 2)
    await assert.rejects(loadInterviewSkillsInBrowser(async () => ({ ok: false, status: 404 })), /could not be read: 404/)
  })
})

describe("Gantry's interview rules", () => {
  test('are the six the ticket names, plus nothing that overrides them', () => {
    assert.deepEqual(INTERVIEW_RULES.map((r) => r.id), ['draft-first', 'provenance', 'saved-content', 'select-fields', 'stage-ready', 'finish'])
    const text = interviewRulesText()
    assert.match(text, /source:<id>/)
    assert.match(text, /"\(target assumption\)"/)
    assert.match(text, /never written/)
    assert.match(text, /only through a question card/)
    assert.match(text, /no "Other"/)
    assert.match(text, /You never pass a Gate/)
    assert.match(text, /Finish with your recommendations/)
  })
})
