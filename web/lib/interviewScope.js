// #287 (parent #238): the Fields the AI interview may write on a Stage. Split out of web/lib/interviewSession.js so the pure
// checks (web/lib/interviewReadiness.js) can use it without loading the session and its AI Provider plumbing.

/** The Fields the AI may draft on `stageId`: every Field of the Stage's Modules that are not read-only here, keyed `module.field`. */
export function fieldsInScope(definition, stageId) {
  const stage = (definition?.stages ?? []).find((s) => s.id === stageId)
  const modules = definition?.modules instanceof Map ? [...definition.modules.values()] : definition?.modules ?? []
  const byId = new Map(modules.map((m) => [m.id, m]))
  const readOnly = new Set(stage?.readOnlyModules ?? [])
  const scope = new Map()
  for (const id of stage?.modules ?? []) {
    const mod = byId.get(id)
    if (!mod || readOnly.has(id)) continue
    for (const field of mod.fields ?? []) scope.set(`${id}.${field.id}`, { module: mod, field })
  }
  return scope
}
