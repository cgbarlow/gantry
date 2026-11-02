// #285 (docs/adr/0065): the two skills the AI interview runs on — Matt Pocock's `grilling` and
// `domain-modeling` (MIT) — bundled UNCHANGED at a pinned version. The files themselves live in
// web/interview-skills/ exactly as released; this module is the one description of which release they
// are, where they came from and under what licence, and how to read them.
//
// **Pinned.** A Gantry release moves to a newer version on purpose, with a CHANGELOG line, so an
// interview behaves the same until Gantry is upgraded. Moving means: replace the files, update
// `INTERVIEW_SKILLS` (version, commit, each file's sha256), and run tests/interviewAdapter.test.js,
// which fails when the new text uses a coding-agent term the adapter (web/lib/interviewAdapter.js)
// does not map. `tests/interviewSkills.test.js` fails when a bundled file differs from its hash, so
// "unchanged" is checked rather than promised.
//
// Pure and dependency-free, like web/lib/standardModules.js, so `lib/` and the MCP server import it
// directly. Reading the files is the caller's job (`readText`): a browser fetches them from
// `/interview-skills/`, Node reads them from `web/interview-skills/`.

/** The URL the web app serves the bundled skill files from. */
export const INTERVIEW_SKILLS_URL = '/interview-skills'

/**
 * The bundled release. `files` are relative to web/interview-skills/ and are listed in the order a
 * skill is read (its SKILL.md first, then the format notes it points to).
 */
export const INTERVIEW_SKILLS = Object.freeze({
  source: 'https://github.com/mattpocock/skills',
  package: 'mattpocock-skills',
  version: '1.2.3',
  commit: '959a8e9f1edc3adbe2f7e3054bb6fbefa6696260',
  author: 'Matt Pocock',
  licence: Object.freeze({
    id: 'MIT',
    file: 'LICENSE',
    sha256: '0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5',
    notice: 'Copyright (c) 2026 Matt Pocock',
  }),
  skills: Object.freeze([
    Object.freeze({
      id: 'grilling',
      title: 'Grilling',
      files: Object.freeze([
        Object.freeze({ path: 'grilling/SKILL.md', sha256: '10ff989e7498b23b5acb49d5048f11dcd906757d2f79c5cdf8a00001381296f2' }),
      ]),
    }),
    Object.freeze({
      id: 'domain-modeling',
      title: 'Domain modeling',
      files: Object.freeze([
        Object.freeze({ path: 'domain-modeling/SKILL.md', sha256: '327a2b50620e2fd70abc6893cd6965e76b20f8d0adb0dc2c8d5eb3845efb643e' }),
        Object.freeze({ path: 'domain-modeling/CONTEXT-FORMAT.md', sha256: '17ab16ce783e4d2801ee52fd9acdf550cbf44de65ae76797a93943bbedf22a13' }),
        Object.freeze({ path: 'domain-modeling/ADR-FORMAT.md', sha256: '944c92aa790e8fbdc9199640b170979abb8a34ba8d0fe18c2a01a63bce140ca0' }),
      ]),
    }),
  ]),
})

/** "grilling and domain modeling, mattpocock-skills 1.2.3" — the skill versions as a reader sees them and as a decisions log records them. */
export function interviewSkillVersions() {
  return {
    package: INTERVIEW_SKILLS.package,
    version: INTERVIEW_SKILLS.version,
    commit: INTERVIEW_SKILLS.commit,
    skills: INTERVIEW_SKILLS.skills.map((skill) => ({ id: skill.id, title: skill.title, version: INTERVIEW_SKILLS.version })),
  }
}

/** The credit line shown wherever the skills are named. */
export function interviewSkillsCredit() {
  return `Skills by ${INTERVIEW_SKILLS.author} (${INTERVIEW_SKILLS.source}), ${INTERVIEW_SKILLS.licence.id} licence, bundled unchanged at ${INTERVIEW_SKILLS.package} ${INTERVIEW_SKILLS.version}.`
}

/**
 * Reads every bundled skill file with `readText(relativePath)` (a string, or a promise of one) and
 * returns `{ version, skills: [{ id, title, files: [{ path, name, text }] }], licence }`. A file that
 * cannot be read rejects with an error naming it, so a broken install is not mistaken for an
 * interview with no skills.
 *
 * @param {(path: string) => string | Promise<string>} readText
 */
export async function loadInterviewSkills(readText) {
  const read = async (path) => {
    let text
    try {
      text = await readText(path)
    } catch (err) {
      throw new Error(`The interview skill file "${path}" could not be read: ${err?.message ?? err}`)
    }
    if (typeof text !== 'string' || text.trim() === '') throw new Error(`The interview skill file "${path}" is empty`)
    return text
  }
  const skills = []
  for (const skill of INTERVIEW_SKILLS.skills) {
    const files = []
    for (const file of skill.files) files.push({ path: file.path, name: file.path.split('/').pop(), text: await read(file.path) })
    skills.push({ id: skill.id, title: skill.title, files })
  }
  const licence = await read(INTERVIEW_SKILLS.licence.file)
  return { ...interviewSkillVersions(), skills, licence }
}

/** `loadInterviewSkills` for the browser: the files are fetched from where the web app serves them. */
export function loadInterviewSkillsInBrowser(fetchImpl = globalThis.fetch) {
  return loadInterviewSkills(async (path) => {
    const res = await fetchImpl(`${INTERVIEW_SKILLS_URL}/${path}`)
    if (!res.ok) throw new Error(`${res.status}`)
    return res.text()
  })
}
