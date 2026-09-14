/**
 * Copy planner for definition elements (WI #382, Feature #380 phase 2). Pure: no DOM, no I/O,
 * no fetch — safe to unit test directly and to import from both the browser bundle and Node.
 *
 * Lifted from web/prototypes/definition-copy.prototype.html's `CopyPlanner` module, which is the
 * primary source for this behaviour (six guided walkthroughs there define what "correct" means).
 * Kept close to that prototype deliberately — this is a lift, not a redesign — with one addition:
 * a `requirement` ref's `req` may itself carry a trailing `?` (optional-in-scope,
 * `lib/definition.js`'s `splitArtefactRequirement`), which the prototype's own scenarios never
 * exercised but the real artefact `requires` shape allows.
 *
 * Definition shape (matches `definitionVersionProjection` in lib/definition.js and the definition
 * editor's own draft state):
 *   { id, version, stages:[{id,title,gate,modules:[moduleId]}],
 *     artefacts:[{id,title,gate,template,requires:[req]}],
 *     modules:[{id,title,fields:[{id,title,type,...}]}] }
 * A req is "module", "module.field" or "module.field?" (optional-in-scope).
 *
 * A ref names the element to copy:
 *   {kind:'module', id}                             module with all fields
 *   {kind:'field',  moduleId, id, targetModuleId}   one field into a target module
 *   {kind:'stage',  id}                             stage + its missing modules
 *   {kind:'artefact', id}                           artefact + template + missing modules
 *   {kind:'requirement', artefactId, req}           field/module onto an artefact's requires
 *     (dropping a field onto an artefact — "field visibility per artefact", CONTEXT.md — takes
 *     this shape; the module comes along if the target doesn't have it yet)
 *
 * Provenance: every element `applyPlan` lands carries `copiedFrom: { definition, version, element }`
 * (`lib/definition.js` round-trips this to/from YAML as `copied-from`) — see
 * docs/adr/0035-copy-with-provenance-not-cross-definition-references.md for why this is a copy,
 * never a live reference.
 */

const clone = (x) => JSON.parse(JSON.stringify(x))
const reqModule = (req) => req.replace(/\?$/, '').split('.')[0]
const byId = (list, id) => list.find((x) => x.id === id)

function provenance(source, kind, id) {
  return { definition: source.id, version: source.version, element: `${kind}:${id}` }
}

/** Which modules `moduleIds` needs that `target` lacks (and that `source` actually has). */
function missingModules(target, source, moduleIds) {
  const missing = []
  for (const id of moduleIds) {
    if (byId(target.modules, id)) continue
    if (!byId(source.modules, id)) continue // source itself is broken; validator's problem, not ours
    if (!missing.includes(id)) missing.push(id)
  }
  return missing
}

/** Default id offered for "keep both, rename the copy" — `<id>-2`, `<id>-3`, … the first free one. */
export function nextFreeId(list, id) {
  let n = 2
  while (byId(list, `${id}-${n}`)) n++
  return `${id}-${n}`
}

/**
 * Build a plan for copying `ref` from `source` into `target`. Never mutates either definition.
 * Collisions start unresolved (`choice: null`); resolve every one with `resolveCollision` before
 * `applyPlan` will accept the plan (see `isResolved`).
 *
 * @param {object} target the definition being edited (the copy's destination)
 * @param {object} source the definition being copied from
 * @param {object} ref which element to copy — see the module doc comment above
 * @returns {{ ref, adds: object[], brings: object[], collisions: object[], errors: string[] }}
 */
export function planCopy(target, source, ref) {
  const plan = { ref, adds: [], brings: [], collisions: [], errors: [] }
  const push = (list, kind, id, extra = {}) => list.push({ kind, id, ...extra })

  if (ref.kind === 'module') {
    const m = byId(source.modules, ref.id)
    if (!m) return { ...plan, errors: [`Source has no module "${ref.id}"`] }
    if (byId(target.modules, ref.id)) {
      plan.collisions.push({ kind: 'module', id: ref.id, options: ['rename', 'replace', 'merge'], choice: null, renameTo: nextFreeId(target.modules, ref.id) })
    } else {
      push(plan.adds, 'module', ref.id)
    }
    return plan
  }

  if (ref.kind === 'field') {
    const m = byId(source.modules, ref.moduleId)
    const f = m && byId(m.fields, ref.id)
    const tm = byId(target.modules, ref.targetModuleId)
    if (!f) return { ...plan, errors: [`Source has no field "${ref.moduleId}.${ref.id}"`] }
    if (!tm) return { ...plan, errors: [`Your definition has no module "${ref.targetModuleId}" to receive the field`] }
    if (byId(tm.fields, ref.id)) {
      plan.collisions.push({ kind: 'field', id: ref.id, moduleId: tm.id, options: ['rename', 'replace'], choice: null, renameTo: nextFreeId(tm.fields, ref.id) })
    } else {
      push(plan.adds, 'field', ref.id, { moduleId: tm.id })
    }
    return plan
  }

  if (ref.kind === 'stage') {
    const s = byId(source.stages, ref.id)
    if (!s) return { ...plan, errors: [`Source has no stage "${ref.id}"`] }
    if (byId(target.stages, ref.id)) {
      plan.collisions.push({ kind: 'stage', id: ref.id, options: ['rename', 'replace', 'merge'], choice: null, renameTo: nextFreeId(target.stages, ref.id) })
    } else {
      push(plan.adds, 'stage', ref.id)
    }
    for (const id of missingModules(target, source, s.modules)) push(plan.brings, 'module', id)
    return plan
  }

  if (ref.kind === 'artefact') {
    const a = byId(source.artefacts, ref.id)
    if (!a) return { ...plan, errors: [`Source has no artefact "${ref.id}"`] }
    if (byId(target.artefacts, ref.id)) {
      plan.collisions.push({ kind: 'artefact', id: ref.id, options: ['rename', 'replace'], choice: null, renameTo: nextFreeId(target.artefacts, ref.id) })
    } else {
      push(plan.adds, 'artefact', ref.id)
    }
    if (a.template) push(plan.brings, 'template', a.template, { docx: a.template.replace(/\.md\.tmpl$/, '') + ' reference .docx' })
    for (const id of missingModules(target, source, a.requires.map(reqModule))) push(plan.brings, 'module', id)
    return plan
  }

  if (ref.kind === 'requirement') {
    const a = byId(target.artefacts, ref.artefactId)
    if (!a) return { ...plan, errors: [`Your definition has no artefact "${ref.artefactId}"`] }
    if (a.requires.includes(ref.req)) return { ...plan, errors: [`"${a.title}" already requires ${ref.req}`] }
    push(plan.adds, 'requirement', ref.req, { artefactId: a.id })
    for (const id of missingModules(target, source, [reqModule(ref.req)])) push(plan.brings, 'module', id)
    return plan
  }

  return { ...plan, errors: [`Unknown copy kind "${ref.kind}"`] }
}

/**
 * Record (or change) the resolution for one collision in `plan` — `choice` must be one of that
 * collision's `options`. Returns a new plan; `plan` itself is never mutated.
 */
export function resolveCollision(plan, id, choice, renameTo) {
  const next = clone(plan)
  const c = next.collisions.find((x) => x.id === id)
  if (!c) return next
  if (!c.options.includes(choice)) throw new Error(`"${choice}" is not offered for ${c.kind} ${c.id}`)
  c.choice = choice
  if (renameTo) c.renameTo = renameTo
  return next
}

/** True once every collision has a choice and nothing in the plan is an outright error. */
export function isResolved(plan) {
  return plan.errors.length === 0 && plan.collisions.every((c) => c.choice)
}

/**
 * Apply a fully resolved plan. Returns `{ target, changed }` — a *new* target definition (the
 * input `target` is never mutated) plus the list of `"kind:id"` strings that changed, for a
 * "what just landed" summary. `source` is never touched or returned — see ADR-0035: a copy is
 * independent from the moment it lands.
 *
 * @throws if the plan has unresolved collisions or outright errors (call `isResolved` first)
 */
export function applyPlan(target, source, plan) {
  if (!isResolved(plan)) throw new Error('Plan has unresolved collisions')
  const t = clone(target)
  const changed = []
  const stamp = (obj, kind, id) => { obj.copiedFrom = provenance(source, kind, id); return obj }

  const landModule = (id, asId = id) => {
    const m = stamp(clone(byId(source.modules, id)), 'module', id)
    m.id = asId
    for (const f of m.fields) stamp(f, 'field', `${id}.${f.id}`)
    const i = t.modules.findIndex((x) => x.id === asId)
    if (i >= 0) t.modules[i] = m
    else t.modules.push(m)
    changed.push(`module:${asId}`)
  }
  const mergeModule = (id) => {
    const src = byId(source.modules, id)
    const dst = byId(t.modules, id)
    for (const f of src.fields) {
      if (!byId(dst.fields, f.id)) {
        dst.fields.push(stamp(clone(f), 'field', `${id}.${f.id}`))
        changed.push(`field:${id}.${f.id}`)
      }
    }
  }

  for (const b of plan.brings) if (b.kind === 'module') landModule(b.id)

  for (const a of plan.adds) {
    if (a.kind === 'module') landModule(a.id)
    if (a.kind === 'field') {
      const f = stamp(clone(byId(byId(source.modules, plan.ref.moduleId).fields, a.id)), 'field', `${plan.ref.moduleId}.${a.id}`)
      byId(t.modules, a.moduleId).fields.push(f)
      changed.push(`field:${a.moduleId}.${a.id}`)
    }
    if (a.kind === 'stage') {
      t.stages.push(stamp(clone(byId(source.stages, a.id)), 'stage', a.id))
      changed.push(`stage:${a.id}`)
    }
    if (a.kind === 'artefact') {
      t.artefacts.push(stamp(clone(byId(source.artefacts, a.id)), 'artefact', a.id))
      changed.push(`artefact:${a.id}`)
    }
    if (a.kind === 'requirement') {
      byId(t.artefacts, a.artefactId).requires.push(a.id)
      changed.push(`requirement:${a.artefactId}:${a.id}`)
    }
  }

  for (const c of plan.collisions) {
    if (c.kind === 'module') {
      if (c.choice === 'rename') landModule(c.id, c.renameTo)
      if (c.choice === 'replace') landModule(c.id)
      if (c.choice === 'merge') mergeModule(c.id)
    }
    if (c.kind === 'field') {
      const src = stamp(clone(byId(byId(source.modules, plan.ref.moduleId).fields, c.id)), 'field', `${plan.ref.moduleId}.${c.id}`)
      const dst = byId(t.modules, c.moduleId)
      if (c.choice === 'rename') { src.id = c.renameTo; dst.fields.push(src); changed.push(`field:${dst.id}.${src.id}`) }
      if (c.choice === 'replace') { dst.fields[dst.fields.findIndex((f) => f.id === c.id)] = src; changed.push(`field:${dst.id}.${c.id}`) }
    }
    if (c.kind === 'stage') {
      const src = stamp(clone(byId(source.stages, c.id)), 'stage', c.id)
      const i = t.stages.findIndex((s) => s.id === c.id)
      if (c.choice === 'rename') { src.id = c.renameTo; t.stages.push(src); changed.push(`stage:${src.id}`) }
      if (c.choice === 'replace') { t.stages[i] = src; changed.push(`stage:${c.id}`) }
      if (c.choice === 'merge') {
        for (const m of src.modules) if (!t.stages[i].modules.includes(m)) t.stages[i].modules.push(m)
        changed.push(`stage:${c.id}`)
      }
    }
    if (c.kind === 'artefact') {
      const src = stamp(clone(byId(source.artefacts, c.id)), 'artefact', c.id)
      if (c.choice === 'rename') { src.id = c.renameTo; t.artefacts.push(src); changed.push(`artefact:${src.id}`) }
      if (c.choice === 'replace') { t.artefacts[t.artefacts.findIndex((a) => a.id === c.id)] = src; changed.push(`artefact:${c.id}`) }
    }
  }
  return { target: t, changed }
}
