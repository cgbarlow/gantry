import { renderArtefact } from '../../lib/render.js'
import { evaluateStage } from '../../lib/status.js'
import { loadDefinition } from '../../lib/definition.js'
import { writeFileSync } from 'node:fs'
const S = process.argv[2]
const definitionsDir = `${S}/definitions`, instancesDir = `${S}/instances`
const def = loadDefinition('recruitment-onboarding', { definitionsDir, version: 3 })
for (const st of def.stages) {
  const r = evaluateStage(def, st, 'platform-engineer', { instancesDir })
  console.log(st.gate, 'complete=', r.complete, r.artefacts.map((a) => `${a.id}:${a.complete ? 'OK' : a.outstanding.join('|')}`).join('  '), r.warnings.length ? 'WARN ' + r.warnings.join(';') : '')
}
for (const a of def.artefacts) {
  try {
    const res = renderArtefact('platform-engineer', a.id, { definitionsDir, instancesDir, dryRun: true, commit: { hash: 'abc1234', fullHash: 'abc1234', date: '2026-09-23' } })
    writeFileSync(`${S}/out-${a.id}.md`, res.markdown)
    console.log('RENDERED', a.id, '->', res.basename)
  } catch (e) { console.log('FAIL', a.id, e.message) }
}
