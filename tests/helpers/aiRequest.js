// #294: an Anthropic request carries its system text as blocks (the first has the one-hour cache point). Tests that look for words in the
// system text read `systemText(body)`; `system` stays a string for them, and the blocks are kept as `systemBlocks`.
export const systemText = (body) => (typeof body?.system === 'string' ? body.system : Array.isArray(body?.system) ? body.system.map((b) => b.text).join('') : '')

/** The request body with `system` as one string and the blocks it came as kept apart (a body with a string system is returned as it is). */
export function withFlatSystem(body) {
  if (!body || !Array.isArray(body.system)) return body
  return { ...body, systemBlocks: body.system, system: systemText(body) }
}
