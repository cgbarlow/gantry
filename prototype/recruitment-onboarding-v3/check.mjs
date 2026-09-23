import { findDefinitionProblems, loadDefinition, splitArtefactRequirement } from '../../lib/definition.js'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
const dd = process.argv[2]
const version = Number(process.argv[3])
const problems = findDefinitionProblems('recruitment-onboarding', { definitionsDir: dd, version })
console.log('PROBLEMS', JSON.stringify(problems, null, 1))
const def = loadDefinition('recruitment-onboarding', { definitionsDir: dd, version })
const raw = parse(readFileSync(`${dd}/recruitment-onboarding/${version}/definition.yaml`, 'utf8'))
const flags = new Map(raw.artefacts.map((a) => [a.id, { sg: a['satisfies-gate'] !== false, dc: a['document-control'] !== false }]))
const isReq = (f, gate) => f.required ? true : (f.requiredAt ? f.requiredAt.includes(gate) : false)
const gates = def.stages.map((s) => s.gate)
// E4-style check: gate ids
for (const a of def.artefacts) if (!gates.includes(a.gate)) console.log('BAD artefact gate', a.id, a.gate)
for (const [mid, m] of def.modules) for (const f of m.fields) for (const g of f.requiredAt ?? []) if (!gates.includes(g)) console.log('BAD required-at', mid, f.id, g)
// every artefact's modules mounted on its stage
for (const a of def.artefacts) {
  const stage = def.stages.find((s) => s.gate === a.gate)
  for (const r of a.requires) { const { moduleId } = splitArtefactRequirement(r); if (!stage.modules.includes(moduleId)) console.log('NOT MOUNTED', a.id, moduleId) }
}
// read-only subset check
for (const s of raw.stages) for (const m of s['read-only'] ?? []) if (!s.modules.includes(m)) console.log('READONLY NOT MOUNTED', s.id, m)
for (const s of def.stages) {
  console.log(`\n=== ${s.id} / ${s.gate}`)
  const arts = def.artefacts.filter((a) => a.gate === s.gate)
  const sets = {}
  for (const a of arts) {
    const gating = []
    for (const r of a.requires) {
      const { moduleId, fieldId, optional } = splitArtefactRequirement(r)
      const f = def.modules.get(moduleId).fields.find((x) => x.id === fieldId)
      if (!optional || isReq(f, s.gate)) gating.push(`${moduleId}.${fieldId}`)
    }
    sets[a.id] = gating
    console.log(`${a.id} satisfies=${flags.get(a.id).sg} docControl=${flags.get(a.id).dc} gating(${gating.length}): ${gating.join(', ')}`)
  }
  // module-level required at this stage
  const modReq = []
  for (const mid of s.modules) for (const f of def.modules.get(mid).fields) if (isReq(f, s.gate)) modReq.push(`${mid}.${f.id}`)
  console.log(`stage-required(${modReq.length}): ${modReq.join(', ')}`)
  const sat = arts.filter((a) => flags.get(a.id).sg).map((a) => a.id)
  if (sat.length > 1) {
    // same-stage fields comparison
    const own = (x) => { const [mid] = x.split('.'); return !(raw.stages.find((st) => st.id === s.id)['read-only'] ?? []).includes(mid) }
    for (const a of sat) console.log(`  same-stage bare in ${a}: ${sets[a].filter(own).join(', ')}`)
  }
}
