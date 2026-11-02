import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A small three-Stage Definition for the AI interview's remote-session tests (#295): each Stage mounts one Module with one required
// Field, and its Gate asks for one Artefact that needs that Field. `PURPOSE-<stage id>` is in each Stage's purpose, so a stand-in AI
// can tell from the brief which Stage it is being asked about.
export const TRIO_STAGES = [
  ['s1', 'Scope', 'g1', 'm1'],
  ['s2', 'Shape', 'g2', 'm2'],
  ['s3', 'Ship', 'g3', 'm3'],
]

export function writeTrio(definitionsDir) {
  const dir = join(definitionsDir, 'trio', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(
    join(dir, 'definition.yaml'),
    [
      'id: trio',
      'version: 1',
      'status: published',
      'title: Trio',
      'stages:',
      ...TRIO_STAGES.flatMap(([id, title, gate, mod]) => [`  - id: ${id}`, `    title: ${title}`, `    purpose: PURPOSE-${id}`, `    gate: ${gate}`, `    modules: [${mod}]`]),
      'artefacts:',
      ...TRIO_STAGES.flatMap(([id, title, gate, mod]) => [`  - id: art-${id}`, `    title: ${title} document`, `    template: templates/${id}.md.tmpl`, `    gate: ${gate}`, `    requires: [${mod}.body]`]),
      '',
    ].join('\n')
  )
  for (const [id, title, , mod] of TRIO_STAGES) {
    writeFileSync(join(dir, 'modules', `${mod}.yaml`), `id: ${mod}\ntitle: ${title} notes\nfields:\n  - id: body\n    title: Body\n    type: markdown\n    required: true\n`)
    writeFileSync(join(dir, 'templates', `${id}.md.tmpl`), `# ${title}\n\n{{${mod}.body}}\n`)
  }
}

/** A saved Module file for the trio, as the editor writes it. */
export const trioModuleText = (moduleId, body = 'The agreed position, written out.') => `---\nmodule: ${moduleId}\nstatus: draft\nowner: ''\n---\n\n# Notes\n\n## Body\n\n${body}\n`
