import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A two-Stage Definition for the AI interview's re-approval tests (#300): Scope (`s1`) mounts `m1` and its Artefact prints `m1.body`;
// Shape (`s2`) mounts `m1` again, shared, plus its own `m2`, and its Artefact needs only `m2.body`. So once Scope is approved, `m1.body`
// is approved content that Shape's interview can change only through a card. `PURPOSE-<stage id>` is in each Stage's purpose.
export function writeDuo(definitionsDir) {
  const dir = join(definitionsDir, 'duo', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(
    join(dir, 'definition.yaml'),
    [
      'id: duo',
      'version: 1',
      'status: published',
      'title: Duo',
      'stages:',
      '  - id: s1',
      '    title: Scope',
      '    purpose: PURPOSE-s1',
      '    gate: g1',
      '    modules: [m1]',
      '  - id: s2',
      '    title: Shape',
      '    purpose: PURPOSE-s2',
      '    gate: g2',
      '    modules: [m1, m2]',
      'artefacts:',
      '  - id: art-s1',
      '    title: Scope document',
      '    template: templates/s1.md.tmpl',
      '    gate: g1',
      '    requires: [m1.body]',
      '  - id: art-s2',
      '    title: Shape document',
      '    template: templates/s2.md.tmpl',
      '    gate: g2',
      '    requires: [m2.body]',
      '',
    ].join('\n')
  )
  writeFileSync(join(dir, 'modules', 'm1.yaml'), 'id: m1\ntitle: Scope notes\nfields:\n  - id: body\n    title: Body\n    type: markdown\n    required: true\n')
  writeFileSync(join(dir, 'modules', 'm2.yaml'), 'id: m2\ntitle: Shape notes\nfields:\n  - id: body\n    title: Body\n    type: markdown\n    required: true\n')
  writeFileSync(join(dir, 'templates', 's1.md.tmpl'), '# Scope\n\n{{m1.body}}\n')
  writeFileSync(join(dir, 'templates', 's2.md.tmpl'), '# Shape\n\n{{m2.body}}\n')
}
