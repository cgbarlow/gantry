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

// #296: with `shared`, Scope and Shape also both mount a Module `mx` (Scope's Gate needs its `body`, Shape's needs its `more`), so Shape
// can be drafted ahead of Scope's approval only in `m2`: `mx` is held until Scope merges.
const mountsOf = (id, mod, shared) => (shared && id === 's1' ? [mod, 'mx'] : shared && id === 's2' ? ['mx', mod] : [mod])
const requiresOf = (id, mod, shared) => (shared && id === 's1' ? [`${mod}.body`, 'mx.body'] : shared && id === 's2' ? [`${mod}.body`, 'mx.more'] : [`${mod}.body`])

export function writeTrio(definitionsDir, { shared = false } = {}) {
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
      ...TRIO_STAGES.flatMap(([id, title, gate, mod]) => [`  - id: ${id}`, `    title: ${title}`, `    purpose: PURPOSE-${id}`, `    gate: ${gate}`, `    modules: [${mountsOf(id, mod, shared).join(', ')}]`]),
      'artefacts:',
      ...TRIO_STAGES.flatMap(([id, title, gate, mod]) => [`  - id: art-${id}`, `    title: ${title} document`, `    template: templates/${id}.md.tmpl`, `    gate: ${gate}`, `    requires: [${requiresOf(id, mod, shared).join(', ')}]`]),
      '',
    ].join('\n')
  )
  for (const [id, title, , mod] of TRIO_STAGES) {
    writeFileSync(join(dir, 'modules', `${mod}.yaml`), `id: ${mod}\ntitle: ${title} notes\nfields:\n  - id: body\n    title: Body\n    type: markdown\n    required: true\n`)
    const extra = shared && id === 's1' ? '\n\n{{mx.body}}' : shared && id === 's2' ? '\n\n{{mx.more}}' : ''
    writeFileSync(join(dir, 'templates', `${id}.md.tmpl`), `# ${title}\n\n{{${mod}.body}}${extra}\n`)
  }
  if (shared) {
    writeFileSync(
      join(dir, 'modules', 'mx.yaml'),
      'id: mx\ntitle: Shared notes\nfields:\n  - id: body\n    title: Body\n    type: markdown\n    required: true\n  - id: more\n    title: More\n    type: markdown\n    required: true\n'
    )
  }
}

/** A saved Module file for the trio, as the editor writes it. */
export const trioModuleText = (moduleId, body = 'The agreed position, written out.') => `---\nmodule: ${moduleId}\nstatus: draft\nowner: ''\n---\n\n# Notes\n\n## Body\n\n${body}\n`
