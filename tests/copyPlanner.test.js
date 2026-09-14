import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planCopy, resolveCollision, applyPlan, isResolved, nextFreeId } from '../lib/copyPlanner.js'

// WI #382 (Feature #380 phase 2): copying a Stage, Artefact, Module or Field from another
// definition. Primary source: web/prototypes/definition-copy.prototype.html's `CopyPlanner` and
// its six guided walkthroughs — the scenarios below follow those walkthroughs closely so the
// lifted module keeps behaving the way the prototype demonstrated it should.

function sourceDef() {
  return {
    id: 'design',
    version: 2,
    status: 'published',
    stages: [
      { id: 'shape', title: 'Shape', gate: 'business-case', modules: ['background', 'risks'] },
      { id: 'handover', title: 'Handover', gate: 'operational-handover', modules: ['glossary', 'background', 'as-built-notes'] },
    ],
    artefacts: [
      { id: 'soap', title: 'Solution on a Page', template: 'templates/soap.md.tmpl', gate: 'business-case', requires: ['background.problem', 'risks.risk-register'] },
      { id: 'as-built', title: 'As-built', template: 'templates/as-built.md.tmpl', gate: 'operational-handover', requires: ['glossary.terms-and-definitions', 'as-built-notes.design-overview'] },
      { id: 'no-template', title: 'No template artefact', template: '', gate: 'business-case', requires: ['risks.risk-register'] },
    ],
    modules: [
      { id: 'background', title: 'Background', fields: [{ id: 'problem', title: 'Problem', type: 'markdown', required: true }, { id: 'opportunity', title: 'Opportunity', type: 'markdown' }] },
      { id: 'risks', title: 'Risks', fields: [{ id: 'risk-register', title: 'Risk register', type: 'markdown', required: true }, { id: 'open-issues', title: 'Open issues', type: 'markdown' }] },
      { id: 'glossary', title: 'Glossary', fields: [{ id: 'terms-and-definitions', title: 'Terms and definitions', type: 'markdown' }] },
      { id: 'as-built-notes', title: 'As-Built Notes', fields: [{ id: 'design-overview', title: 'Design overview', type: 'markdown' }] },
    ],
  }
}

function targetDef() {
  return {
    id: 'procurement',
    version: 1,
    status: 'draft',
    stages: [
      { id: 'shape', title: 'Shape the need', gate: 'business-case', modules: ['background'] },
    ],
    artefacts: [
      { id: 'soap', title: 'Procurement on a Page', template: 'templates/soap.md.tmpl', gate: 'business-case', requires: ['background.problem'] },
    ],
    modules: [
      { id: 'background', title: 'Background', fields: [{ id: 'problem', title: 'Problem', type: 'markdown' }, { id: 'sponsor', title: 'Sponsor', type: 'markdown' }] },
      { id: 'risks', title: 'Procurement risks', fields: [{ id: 'risk-register', title: 'Risk register', type: 'markdown' }, { id: 'appetite', title: 'Risk appetite', type: 'markdown' }] },
    ],
  }
}

// ---------------------------------------------------------------- planCopy

test('planCopy: plain module copy with no collision — one add, nothing brought, nothing to resolve', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'module', id: 'glossary' })
  assert.deepEqual(plan.errors, [])
  assert.equal(plan.adds.length, 1)
  assert.equal(plan.adds[0].kind, 'module')
  assert.equal(plan.adds[0].id, 'glossary')
  assert.equal(plan.brings.length, 0)
  assert.equal(plan.collisions.length, 0)
  assert.equal(isResolved(plan), true)
})

test('planCopy: module copy errors when the source has no such module', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'module', id: 'nope' })
  assert.deepEqual(plan.errors, ['Source has no module "nope"'])
  assert.equal(isResolved(plan), false)
})

test('planCopy: module copy collides when the target already has that id', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'module', id: 'risks' })
  assert.equal(plan.adds.length, 0)
  assert.equal(plan.collisions.length, 1)
  const c = plan.collisions[0]
  assert.equal(c.kind, 'module')
  assert.equal(c.id, 'risks')
  assert.deepEqual(c.options, ['rename', 'replace', 'merge'])
  assert.equal(c.choice, null)
  assert.equal(c.renameTo, 'risks-2')
  assert.equal(isResolved(plan), false)
})

test('planCopy: stage copy brings every module the target lacks, in source order, deduped', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'stage', id: 'handover' })
  assert.equal(plan.adds.length, 1)
  assert.equal(plan.adds[0].id, 'handover')
  // handover needs glossary, background, as-built-notes; target already has background
  assert.deepEqual(plan.brings.map((b) => b.id), ['glossary', 'as-built-notes'])
  assert.equal(plan.collisions.length, 0)
})

test('planCopy: stage copy collides on id but still reports the modules it would bring', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'stage', id: 'shape' })
  assert.equal(plan.collisions.length, 1)
  assert.equal(plan.collisions[0].kind, 'stage')
  assert.deepEqual(plan.collisions[0].options, ['rename', 'replace', 'merge'])
  // shape's modules (background, risks) are both already present in the target by id
  assert.deepEqual(plan.brings, [])
})

test('planCopy: stage copy errors when the source has no such stage', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'stage', id: 'nope' })
  assert.deepEqual(plan.errors, ['Source has no stage "nope"'])
})

test('planCopy: artefact copy brings its template, reference docx, and missing required modules', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'artefact', id: 'as-built' })
  assert.equal(plan.adds.length, 1)
  assert.equal(plan.adds[0].id, 'as-built')
  const templateBring = plan.brings.find((b) => b.kind === 'template')
  assert.ok(templateBring)
  assert.equal(templateBring.id, 'templates/as-built.md.tmpl')
  assert.match(templateBring.docx, /reference \.docx$/)
  const moduleBrings = plan.brings.filter((b) => b.kind === 'module').map((b) => b.id)
  assert.deepEqual(moduleBrings, ['glossary', 'as-built-notes'])
})

test('planCopy: artefact copy with no template brings no template/docx entry', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'artefact', id: 'no-template' })
  assert.equal(plan.brings.some((b) => b.kind === 'template'), false)
})

test('planCopy: artefact copy collides on id', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'artefact', id: 'soap' })
  assert.equal(plan.collisions.length, 1)
  assert.equal(plan.collisions[0].kind, 'artefact')
  assert.deepEqual(plan.collisions[0].options, ['rename', 'replace'])
})

test('planCopy: artefact copy errors when the source has no such artefact', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'artefact', id: 'nope' })
  assert.deepEqual(plan.errors, ['Source has no artefact "nope"'])
})

test('planCopy: field copy into an existing target module with no collision', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'field', moduleId: 'risks', id: 'open-issues', targetModuleId: 'risks' })
  assert.equal(plan.adds.length, 1)
  assert.equal(plan.adds[0].kind, 'field')
  assert.equal(plan.adds[0].id, 'open-issues')
  assert.equal(plan.adds[0].moduleId, 'risks')
  assert.equal(plan.collisions.length, 0)
})

test('planCopy: field copy collides when the target module already has that field id', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'field', moduleId: 'risks', id: 'risk-register', targetModuleId: 'risks' })
  assert.equal(plan.collisions.length, 1)
  assert.equal(plan.collisions[0].kind, 'field')
  assert.deepEqual(plan.collisions[0].options, ['rename', 'replace'])
})

test('planCopy: field copy errors when the source field does not exist', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'field', moduleId: 'risks', id: 'nope', targetModuleId: 'risks' })
  assert.deepEqual(plan.errors, ['Source has no field "risks.nope"'])
})

test('planCopy: field copy errors when the target module does not exist', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'field', moduleId: 'risks', id: 'open-issues', targetModuleId: 'nope' })
  assert.deepEqual(plan.errors, ['Your definition has no module "nope" to receive the field'])
})

test('planCopy: requirement (field onto an artefact) adds one requirement and brings the missing module', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'requirement', artefactId: 'soap', req: 'glossary.terms-and-definitions' })
  assert.equal(plan.adds.length, 1)
  assert.deepEqual(plan.adds[0], { kind: 'requirement', id: 'glossary.terms-and-definitions', artefactId: 'soap' })
  assert.equal(plan.brings.length, 1)
  assert.equal(plan.brings[0].kind, 'module')
  assert.equal(plan.brings[0].id, 'glossary')
})

test('planCopy: requirement does not bring a module the target already has', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'requirement', artefactId: 'soap', req: 'background.opportunity' })
  assert.equal(plan.brings.length, 0)
})

test('planCopy: requirement is refused outright when the artefact already requires it', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'requirement', artefactId: 'soap', req: 'background.problem' })
  assert.match(plan.errors[0], /already requires/)
  assert.equal(plan.adds.length, 0)
})

test('planCopy: requirement errors when the target artefact does not exist', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'requirement', artefactId: 'nope', req: 'background.opportunity' })
  assert.deepEqual(plan.errors, ['Your definition has no artefact "nope"'])
})

// ---------------------------------------------------------------- resolveCollision

test('resolveCollision: sets choice and default renameTo without mutating the input plan', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'module', id: 'risks' })
  const next = resolveCollision(plan, 'risks', 'merge')
  assert.equal(plan.collisions[0].choice, null) // original untouched
  assert.equal(next.collisions[0].choice, 'merge')
  assert.equal(isResolved(next), true)
})

test('resolveCollision: rename with a custom id overrides the default renameTo', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'module', id: 'risks' })
  const next = resolveCollision(plan, 'risks', 'rename', 'risks-design')
  assert.equal(next.collisions[0].choice, 'rename')
  assert.equal(next.collisions[0].renameTo, 'risks-design')
})

test('resolveCollision: rejects a choice not offered for that collision kind', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'field', moduleId: 'risks', id: 'risk-register', targetModuleId: 'risks' })
  assert.throws(() => resolveCollision(plan, 'risk-register', 'merge'), /"merge" is not offered for field risk-register/)
})

test('resolveCollision: a no-op for an id that has no matching collision', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'module', id: 'glossary' })
  const next = resolveCollision(plan, 'not-a-collision', 'replace')
  assert.deepEqual(next, plan)
})

// ---------------------------------------------------------------- nextFreeId

test('nextFreeId: finds the first free "<id>-n" starting at 2', () => {
  assert.equal(nextFreeId([{ id: 'risks' }], 'risks'), 'risks-2')
  assert.equal(nextFreeId([{ id: 'risks' }, { id: 'risks-2' }], 'risks'), 'risks-3')
  assert.equal(nextFreeId([{ id: 'risks' }, { id: 'risks-2' }, { id: 'risks-3' }], 'risks'), 'risks-4')
})

// ---------------------------------------------------------------- applyPlan

test('applyPlan: throws on an unresolved plan', () => {
  const plan = planCopy(targetDef(), sourceDef(), { kind: 'module', id: 'risks' })
  assert.throws(() => applyPlan(targetDef(), sourceDef(), plan), /unresolved collisions/)
})

test('applyPlan: plain module lands with provenance on the module and every field; source untouched', () => {
  const source = sourceDef()
  const target = targetDef()
  const plan = planCopy(target, source, { kind: 'module', id: 'glossary' })
  const { target: result, changed } = applyPlan(target, source, plan)
  assert.deepEqual(changed, ['module:glossary'])
  const landed = result.modules.find((m) => m.id === 'glossary')
  assert.ok(landed)
  assert.deepEqual(landed.copiedFrom, { definition: 'design', version: 2, element: 'module:glossary' })
  assert.deepEqual(landed.fields[0].copiedFrom, { definition: 'design', version: 2, element: 'field:glossary.terms-and-definitions' })
  // source untouched
  assert.equal(source.modules.find((m) => m.id === 'glossary').copiedFrom, undefined)
  assert.equal(target.modules.some((m) => m.id === 'glossary'), false)
})

test('applyPlan: stage brings its missing modules along, each stamped with its own provenance', () => {
  const source = sourceDef()
  const target = targetDef()
  const plan = planCopy(target, source, { kind: 'stage', id: 'handover' })
  const { target: result, changed } = applyPlan(target, source, plan)
  assert.ok(changed.includes('stage:handover'))
  assert.ok(changed.includes('module:glossary'))
  assert.ok(changed.includes('module:as-built-notes'))
  const stage = result.stages.find((s) => s.id === 'handover')
  assert.deepEqual(stage.copiedFrom, { definition: 'design', version: 2, element: 'stage:handover' })
  assert.ok(result.modules.find((m) => m.id === 'glossary'))
  assert.ok(result.modules.find((m) => m.id === 'as-built-notes'))
  // background already existed and was not touched/duplicated
  assert.equal(result.modules.filter((m) => m.id === 'background').length, 1)
  assert.equal(result.modules.find((m) => m.id === 'background').copiedFrom, undefined)
})

test('applyPlan: artefact lands with its full requires list, template, and provenance', () => {
  const source = sourceDef()
  const target = targetDef()
  const plan = planCopy(target, source, { kind: 'artefact', id: 'as-built' })
  const { target: result } = applyPlan(target, source, plan)
  const artefact = result.artefacts.find((a) => a.id === 'as-built')
  assert.ok(artefact)
  assert.deepEqual(artefact.requires, ['glossary.terms-and-definitions', 'as-built-notes.design-overview'])
  assert.deepEqual(artefact.copiedFrom, { definition: 'design', version: 2, element: 'artefact:as-built' })
  assert.ok(result.modules.find((m) => m.id === 'glossary'))
  assert.ok(result.modules.find((m) => m.id === 'as-built-notes'))
})

test('applyPlan: requirement adds the field ref to the artefact and brings the missing module', () => {
  const source = sourceDef()
  const target = targetDef()
  const plan = planCopy(target, source, { kind: 'requirement', artefactId: 'soap', req: 'glossary.terms-and-definitions' })
  const { target: result, changed } = applyPlan(target, source, plan)
  const artefact = result.artefacts.find((a) => a.id === 'soap')
  assert.ok(artefact.requires.includes('glossary.terms-and-definitions'))
  assert.ok(result.modules.find((m) => m.id === 'glossary'))
  assert.ok(changed.includes('requirement:soap:glossary.terms-and-definitions'))
  // artefact itself carries no provenance stamp — only the module that came along does
  assert.equal(artefact.copiedFrom, undefined)
})

// ---- module collision resolutions: rename / replace / merge ----

test('applyPlan: module collision — rename keeps both under the new id, original untouched', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'module', id: 'risks' })
  plan = resolveCollision(plan, 'risks', 'rename', 'risks-design')
  const { target: result } = applyPlan(target, source, plan)
  assert.equal(result.modules.filter((m) => m.id === 'risks' || m.id === 'risks-design').length, 2)
  const original = result.modules.find((m) => m.id === 'risks')
  assert.equal(original.title, 'Procurement risks')
  assert.equal(original.copiedFrom, undefined)
  const copy = result.modules.find((m) => m.id === 'risks-design')
  assert.equal(copy.title, 'Risks')
  assert.deepEqual(copy.copiedFrom, { definition: 'design', version: 2, element: 'module:risks' })
})

test('applyPlan: module collision — replace overwrites the target module wholesale', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'module', id: 'risks' })
  plan = resolveCollision(plan, 'risks', 'replace')
  const { target: result } = applyPlan(target, source, plan)
  const risks = result.modules.filter((m) => m.id === 'risks')
  assert.equal(risks.length, 1)
  assert.equal(risks[0].title, 'Risks') // source's title, not "Procurement risks"
  assert.equal(risks[0].fields.some((f) => f.id === 'appetite'), false) // target-only field is gone
  assert.deepEqual(risks[0].copiedFrom, { definition: 'design', version: 2, element: 'module:risks' })
})

test('applyPlan: module collision — merge adds only the fields the target lacks, leaves the rest untouched', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'module', id: 'risks' })
  plan = resolveCollision(plan, 'risks', 'merge')
  const { target: result, changed } = applyPlan(target, source, plan)
  const risks = result.modules.find((m) => m.id === 'risks')
  assert.equal(risks.title, 'Procurement risks') // target's own title survives
  assert.equal(risks.copiedFrom, undefined) // the module itself isn't stamped, only the field that landed
  const openIssues = risks.fields.find((f) => f.id === 'open-issues')
  assert.ok(openIssues)
  assert.deepEqual(openIssues.copiedFrom, { definition: 'design', version: 2, element: 'field:risks.open-issues' })
  const appetite = risks.fields.find((f) => f.id === 'appetite')
  assert.ok(appetite) // target-only field survives
  const riskRegister = risks.fields.find((f) => f.id === 'risk-register')
  assert.equal(riskRegister.copiedFrom, undefined) // already present, not overwritten
  assert.deepEqual(changed, ['field:risks.open-issues'])
})

// ---- field collision resolutions: rename / replace ----

test('applyPlan: field collision — rename keeps both fields, the copy under the new id', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'field', moduleId: 'risks', id: 'risk-register', targetModuleId: 'risks' })
  plan = resolveCollision(plan, 'risk-register', 'rename', 'risk-register-2')
  const { target: result } = applyPlan(target, source, plan)
  const risks = result.modules.find((m) => m.id === 'risks')
  assert.equal(risks.fields.some((f) => f.id === 'risk-register'), true)
  const renamed = risks.fields.find((f) => f.id === 'risk-register-2')
  assert.ok(renamed)
  assert.deepEqual(renamed.copiedFrom, { definition: 'design', version: 2, element: 'field:risks.risk-register' })
})

test('applyPlan: field collision — replace overwrites just that field in place', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'field', moduleId: 'risks', id: 'risk-register', targetModuleId: 'risks' })
  plan = resolveCollision(plan, 'risk-register', 'replace')
  const { target: result } = applyPlan(target, source, plan)
  const risks = result.modules.find((m) => m.id === 'risks')
  assert.equal(risks.fields.length, 2) // risk-register (replaced) + appetite, unchanged count
  const replaced = risks.fields.find((f) => f.id === 'risk-register')
  assert.deepEqual(replaced.copiedFrom, { definition: 'design', version: 2, element: 'field:risks.risk-register' })
  assert.equal(replaced.required, true) // source's field carried required:true
})

// ---- stage collision resolutions: rename / replace / merge-as-union ----

test('applyPlan: stage collision — rename keeps both stages', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'stage', id: 'shape' })
  plan = resolveCollision(plan, 'shape', 'rename', 'shape-design')
  const { target: result } = applyPlan(target, source, plan)
  assert.equal(result.stages.some((s) => s.id === 'shape'), true)
  const renamed = result.stages.find((s) => s.id === 'shape-design')
  assert.ok(renamed)
  assert.deepEqual(renamed.copiedFrom, { definition: 'design', version: 2, element: 'stage:shape' })
})

test('applyPlan: stage collision — replace overwrites the stage wholesale, including its module list', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'stage', id: 'shape' })
  plan = resolveCollision(plan, 'shape', 'replace')
  const { target: result } = applyPlan(target, source, plan)
  const stages = result.stages.filter((s) => s.id === 'shape')
  assert.equal(stages.length, 1)
  assert.deepEqual(stages[0].modules, ['background', 'risks'])
  assert.equal(stages[0].title, 'Shape')
})

test('applyPlan: stage collision — merge is the union of module lists, no duplicates', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'stage', id: 'shape' })
  plan = resolveCollision(plan, 'shape', 'merge')
  const { target: result } = applyPlan(target, source, plan)
  const stage = result.stages.find((s) => s.id === 'shape')
  assert.equal(stage.title, 'Shape the need') // target's own title survives a merge
  assert.deepEqual(stage.modules, ['background', 'risks']) // background (already there) + risks (union)
})

// ---- artefact collision resolutions: rename / replace ----

test('applyPlan: artefact collision — rename keeps both artefacts', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'artefact', id: 'soap' })
  plan = resolveCollision(plan, 'soap', 'rename', 'soap-design')
  const { target: result } = applyPlan(target, source, plan)
  assert.equal(result.artefacts.some((a) => a.id === 'soap'), true)
  const renamed = result.artefacts.find((a) => a.id === 'soap-design')
  assert.ok(renamed)
  assert.deepEqual(renamed.copiedFrom, { definition: 'design', version: 2, element: 'artefact:soap' })
})

test('applyPlan: artefact collision — replace overwrites the artefact wholesale', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'artefact', id: 'soap' })
  plan = resolveCollision(plan, 'soap', 'replace')
  const { target: result } = applyPlan(target, source, plan)
  const artefacts = result.artefacts.filter((a) => a.id === 'soap')
  assert.equal(artefacts.length, 1)
  assert.equal(artefacts[0].title, 'Solution on a Page')
  assert.deepEqual(artefacts[0].requires, ['background.problem', 'risks.risk-register'])
})

test('applyPlan: renaming a copy preserves the element name in provenance — the trail survives the rename', () => {
  const source = sourceDef()
  const target = targetDef()
  let plan = planCopy(target, source, { kind: 'module', id: 'risks' })
  plan = resolveCollision(plan, 'risks', 'rename', 'risks-design')
  const { target: result } = applyPlan(target, source, plan)
  const copy = result.modules.find((m) => m.id === 'risks-design')
  assert.equal(copy.copiedFrom.element, 'module:risks')
})
