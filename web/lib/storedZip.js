// #310 (map #238): a zip of stored (uncompressed) files, made in the browser, so a set of Source documents can be downloaded together. A brief, a
// spreadsheet, a Word file and a PDF are already compressed, so deflating them again buys nothing and this needs no compression stream.
// It has no DOM and no network.
import { crc32 } from './definitionLogo.js'

// 1 January 1980, 00:00: the earliest time a zip can hold. A downloaded pack has no meaningful file times.
const DOS_DATE = 0x21

/**
 * The zip holding `files` (`[{ name, bytes }]`, `bytes` a `Uint8Array`), in order. File names are written as given, in UTF-8; the caller
 * keeps them unique and free of folders it does not want.
 */
export function storedZip(files) {
  const encoder = new TextEncoder()
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const raw = file.bytes
    const crc = crc32(raw)
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(12, DOS_DATE, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, raw.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(14, DOS_DATE, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, raw.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    locals.push(local, raw)
    centrals.push(central)
    offset += local.length + raw.length
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const all = [...locals, ...centrals, end]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const piece of all) {
    out.set(piece, at)
    at += piece.length
  }
  return out
}
