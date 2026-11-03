// #301/#302 (ADR-0066): the name of the invisible Word bookmark Gantry wraps around a printed Field,
// `gf_` plus eight hex digits of a SHA-1 of `module/field`. The renderer (lib/wordFieldTags.js) writes
// the bookmark and the Reviewed-copy reader (web/lib/reviewedCopy.js) recomputes the same name from the
// Definition to find the Field again, so the document needs no lookup table. It lives here, free of
// `node:crypto`, because the reader runs in the browser; the SHA-1 is the plain algorithm, and
// tests/reviewedCopy.test.js checks it against `node:crypto`.

// A Word bookmark name begins with a letter and holds letters, digits and underscores. A Field printed
// more than once in one document gets `_2`, `_3`, … on its later copies, in document order.
export const FIELD_BOOKMARK_PREFIX = 'gf_'

const FIELD_BOOKMARK_RE = /^gf_([0-9a-f]{8})(?:_\d+)?$/

function sha1Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const bitLength = bytes.length * 8
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  const rotl = (x, n) => (x << n) | (x >>> (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f
      let k
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = rotl(b, 30) >>> 0
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('')
}

const names = new Map()

/** The bookmark name for a Field: `gf_` and eight hex digits, the same on every render. */
export function fieldBookmarkName(moduleId, fieldId) {
  const key = `${moduleId}/${fieldId}`
  let name = names.get(key)
  if (!name) {
    name = FIELD_BOOKMARK_PREFIX + sha1Hex(key).slice(0, 8)
    names.set(key, name)
  }
  return name
}

/** The Field bookmark a document bookmark name is (`gf_3f9a1c2e_2` is `gf_3f9a1c2e`), or `null` when it is not one of Gantry's. */
export function baseFieldBookmark(name) {
  const match = FIELD_BOOKMARK_RE.exec(String(name ?? ''))
  return match ? FIELD_BOOKMARK_PREFIX + match[1] : null
}
