import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A small two-Stage Definition for Bring up to date's browser tests (#298). Alpha mounts `ma` (its own) and `ms` (shared); Beta mounts `mb` (its
// own) and `ms`. Each Stage's Gate asks for one Artefact that needs the Stage's own Module. `PURPOSE-<stage id>` is in each Stage's purpose.
export const PAIR_STAGES = [
  ['a', 'Alpha', 'ga', ['ma', 'ms']],
  ['b', 'Beta', 'gb', ['mb', 'ms']],
]

const MODULES = { ma: 'Alpha notes', mb: 'Beta notes', ms: 'Shared notes' }

export function writePair(definitionsDir) {
  const dir = join(definitionsDir, 'pair', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(
    join(dir, 'definition.yaml'),
    [
      'id: pair',
      'version: 1',
      'status: published',
      'title: Pair',
      'stages:',
      ...PAIR_STAGES.flatMap(([id, title, gate, modules]) => [`  - id: ${id}`, `    title: ${title}`, `    purpose: PURPOSE-${id}`, `    gate: ${gate}`, `    modules: [${modules.join(', ')}]`]),
      'artefacts:',
      ...PAIR_STAGES.flatMap(([id, title, gate, modules]) => [`  - id: art-${id}`, `    title: ${title} document`, `    template: templates/${id}.md.tmpl`, `    gate: ${gate}`, `    requires: [${modules[0]}.body]`]),
      '',
    ].join('\n')
  )
  for (const [id, title] of Object.entries(MODULES)) {
    writeFileSync(join(dir, 'modules', `${id}.yaml`), `id: ${id}\ntitle: ${title}\nfields:\n  - id: body\n    title: Body\n    type: markdown\n    required: true\n`)
  }
  for (const [id, title, , modules] of PAIR_STAGES) {
    writeFileSync(join(dir, 'templates', `${id}.md.tmpl`), `# ${title}\n\n${modules.map((m) => `{{${m}.body}}`).join('\n\n')}\n`)
  }
}

/** A saved Module file for the pair, as the editor writes it. */
export const pairModuleText = (moduleId, body, status = 'draft') => `---\nmodule: ${moduleId}\nstatus: ${status}\nowner: ''\n---\n\n# ${MODULES[moduleId]}\n\n## Body\n\n${body}\n`
