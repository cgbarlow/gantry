// A stage's version, and the Field-by-Field settling of a clash (ADR-0068, #270).
//
// Before a Save, the editor (and the server, on the editor's behalf) compares the
// stage's version now with the one noted when the stage was read. A stage's version is a
// fingerprint of its content — every Field of every Module the stage mounts, with each
// Module's status and owner — and nothing else: an Asset upload, a rendered document or a
// new commit that changed no Field leaves it as it was, so it raises no clash.
//
// This is the one implementation. The server (lib/server.js) and the browser (web/app.js,
// including a Local workspace, which is read and written in the browser) both import it,
// so the fingerprint is the same in every workspace kind. It is pure and synchronous so
// it is tested without a browser.

import { modulePayload } from './stageSave.js'

// ---- SHA-256 (synchronous, so it runs in an insecure-context browser too) ----

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x, n) => (x >>> n) | (x << (32 - n))

export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6)
  const data = new Uint8Array(paddedLength)
  data.set(bytes)
  data[bytes.length] = 0x80
  const view = new DataView(data.buffer)
  view.setUint32(paddedLength - 8, Math.floor((bytes.length * 8) / 0x100000000))
  view.setUint32(paddedLength - 4, (bytes.length * 8) >>> 0)

  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] += a
    h[1] += b
    h[2] += c
    h[3] += d
    h[4] += e
    h[5] += f
    h[6] += g
    h[7] += hh
  }
  return Array.from(h, (n) => n.toString(16).padStart(8, '0')).join('')
}

// ---- Units: the Fields a clash is settled on ----

// Normalised the way saving normalises (list items trimmed, blank rows dropped, line endings
// as the editor holds them), so two values compare equal exactly when they save the same.
function normaliseValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter((item) => item !== '')
  return String(value ?? '').replace(/\r\n?/g, '\n')
}

const STATUS_KEY = 'status'
const OWNER_KEY = 'owner'

function customKeyBase(title) {
  return `custom:${String(title ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}`
}

// A Module payload (`{ status, owner, fields, layout }`, see stageSave.js's modulePayload)
// as its settle-able units: `status`, `owner`, each defined Field (`field:<id>`) and each
// custom section (`custom:<title>`, `#2`… when two share a title — a section's client-side
// id changes on reload, its title does not), plus the document order.
export function moduleUnits(payload) {
  const units = new Map()
  const order = []
  const seenTitles = new Map()
  units.set(STATUS_KEY, { value: payload?.status ?? '' })
  units.set(OWNER_KEY, { value: payload?.owner ?? '' })
  for (const entry of payload?.layout ?? []) {
    if (entry.custom) {
      const base = customKeyBase(entry.custom.title)
      const count = (seenTitles.get(base) ?? 0) + 1
      seenTitles.set(base, count)
      const key = count === 1 ? base : `${base}#${count}`
      units.set(key, {
        custom: true,
        id: entry.custom.id,
        title: entry.custom.title ?? '',
        type: entry.custom.type === 'list' ? 'list' : 'markdown',
        value: normaliseValue(entry.custom.value),
      })
      order.push(key)
    } else {
      const key = `field:${entry.field}`
      units.set(key, { value: normaliseValue(payload.fields?.[entry.field]) })
      order.push(key)
    }
  }
  return { units, order }
}

const unitSignature = (unit) => (unit === undefined ? 'absent' : JSON.stringify(unit.custom ? [unit.title, unit.type, unit.value] : unit.value))
const sameUnit = (a, b) => unitSignature(a) === unitSignature(b)
const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i])

// A Module's content as one comparable string — equal exactly when the two payloads save the
// same Fields in the same order.
export function moduleContentKey(payload) {
  const { units, order } = moduleUnits(payload)
  return JSON.stringify([units.get(STATUS_KEY).value, units.get(OWNER_KEY).value, order.map((key) => [key, unitSignature(units.get(key))])])
}

// ---- The version ----

// `payloads` maps Module id to its payload. The version is the same whatever order the
// Modules arrive in.
export function stageVersionOfPayloads(payloads) {
  const ids = Object.keys(payloads).sort()
  const content = ids.map((id) => [id, moduleContentKey(payloads[id])])
  return sha256Hex(JSON.stringify(content)).slice(0, 16)
}

// The payloads of a stage's Module entries (what `GET /api/instance` returns as `modules`).
export function stagePayloads(modules) {
  return Object.fromEntries(modules.map((mod) => [mod.id, modulePayload(mod)]))
}

export function stageVersionOfModules(modules) {
  return stageVersionOfPayloads(stagePayloads(modules))
}

// ---- Settling a clash, Field by Field ----

export const conflictKey = (moduleId, key) => `${moduleId}\u0000${key}`

function payloadFromUnits(units, order) {
  const fields = {}
  const layout = []
  for (const key of order) {
    const unit = units.get(key)
    if (!unit) continue
    if (unit.custom) {
      const id = unit.id ?? key
      fields[id] = unit.value
      layout.push({ custom: { id, title: unit.title, type: unit.type, value: unit.value } })
    } else {
      const id = key.slice('field:'.length)
      fields[id] = unit.value
      layout.push({ field: id })
    }
  }
  return { status: units.get(STATUS_KEY)?.value ?? '', owner: units.get(OWNER_KEY)?.value ?? '', fields, layout }
}

// The unit a resolution stands for: `{ remove: true }` drops a section, `{ value }` sets the
// Field (for a section, on top of the title and type of whichever side has it).
function resolvedUnit(resolution, mine, theirs) {
  if (resolution.remove) return undefined
  const from = mine ?? theirs
  return from?.custom ? { ...from, value: normaliseValue(resolution.value) } : { value: normaliseValue(resolution.value) }
}

function mergeModule(moduleId, baseUnits, mineUnits, theirsUnits, resolutions, conflicts) {
  const keys = []
  const seen = new Set()
  for (const key of [STATUS_KEY, OWNER_KEY, ...theirsUnits.order, ...mineUnits.order, ...baseUnits.order]) {
    if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
  }

  const merged = new Map()
  for (const key of keys) {
    const base = baseUnits.units.get(key)
    const mine = mineUnits.units.get(key)
    const theirs = theirsUnits.units.get(key)
    let result
    if (sameUnit(mine, theirs)) result = mine // nobody differs (or both made the same change)
    else if (sameUnit(base, theirs)) result = mine // only the saver changed it: theirs is kept
    else if (sameUnit(base, mine)) result = theirs // only the saved side changed it: theirs is taken
    else {
      const resolution = resolutions[conflictKey(moduleId, key)]
      if (resolution) result = resolvedUnit(resolution, mine, theirs)
      else {
        conflicts.push({ moduleId, key, kind: key === STATUS_KEY || key === OWNER_KEY ? key : mine?.custom || theirs?.custom ? 'custom' : 'field', mine, theirs, base })
        result = mine
      }
    }
    if (result !== undefined) merged.set(key, result)
  }

  // Order: the saver's if they changed it, otherwise the saved side's; anything the chosen
  // order lacks (a section only the other side added) follows in the other side's order.
  const chosen = sameList(mineUnits.order, baseUnits.order) ? theirsUnits.order : mineUnits.order
  const order = chosen.filter((key) => merged.has(key))
  for (const key of [...theirsUnits.order, ...mineUnits.order]) {
    if (merged.has(key) && !order.includes(key)) order.push(key)
  }
  return payloadFromUnits(merged, order)
}

// Settles `mine` against `theirs` given `base`, each a map of Module id to payload:
//   base   - what the saver started from (the stage as it was read, or as last saved);
//   mine   - what the saver has (the unsaved editor content; `base` for a Module they didn't touch);
//   theirs - what is saved now.
// Per Field: only the saved side changed -> theirs is taken; only the saver changed -> theirs is
// kept; both changed it differently -> a conflict, until `resolutions` (conflictKey -> `{ value }`
// or `{ remove: true }`) says which. Returns `{ payloads, conflicts, toWrite }`: the settled
// payload of every Module, the still-unresolved conflicts, and the Modules whose settled content
// differs from what is saved now (the only ones a Save needs to write).
export function mergeStage({ base = {}, mine = {}, theirs = {}, resolutions = {} }) {
  const payloads = {}
  const conflicts = []
  const toWrite = []
  const ids = [...new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(base)])]
  for (const id of ids) {
    const theirsPayload = theirs[id]
    const minePayload = mine[id] ?? base[id]
    if (!theirsPayload) {
      payloads[id] = minePayload
      toWrite.push(id)
      continue
    }
    const basePayload = base[id] ?? theirsPayload
    payloads[id] = mergeModule(id, moduleUnits(basePayload), moduleUnits(minePayload ?? basePayload), moduleUnits(theirsPayload), resolutions, conflicts)
    if (moduleContentKey(payloads[id]) !== moduleContentKey(theirsPayload)) toWrite.push(id)
  }
  return { payloads, conflicts, toWrite }
}

// What a Field stands for in a clash dialog: its value as editable text, and back.
export function conflictText(value) {
  if (value === undefined) return ''
  return Array.isArray(value) ? value.join('\n') : String(value)
}

export function conflictValueFromText(text, like) {
  if (Array.isArray(like)) return text.split('\n').map((item) => item.trim()).filter((item) => item !== '')
  return text
}
