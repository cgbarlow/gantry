import { extractSourceText } from '../web/lib/sourceExtract.js'

// #305 (docs/adr/0067): the text of a Source document uploaded over MCP. The browser reads a document itself and sends the text with it;
// an outside agent has no browser, so `gantry serve` runs the very same reader (web/lib/sourceExtract.js) with officeparser's Node build
// in place of the browser one. That reader is the one thing that decides what text a document gives, so an MCP upload and a browser upload
// of the same file produce the same extracted text and the same manifest entry. Nothing leaves the server: the document is already on it,
// having just been uploaded, and a local workspace (whose files never reach the server) never comes here.

let parserPromise = null

// officeparser is loaded the first time a document is read, not when the server starts. Node finds pdf.js in node_modules itself, so the
// browser-only URLs `officeParserConfig` adds for pdf.js's worker, CMaps and decoders are left out.
function loadNodeParser() {
  if (!parserPromise) {
    parserPromise = import('officeparser')
      .then((officeparser) => ({
        parseOffice: (bytes, { pdfWorkerSrc: _worker, pdfCMapUrl: _cmaps, pdfDecoderUrl: _decoders, ...config }) => (officeparser.parseOffice ?? officeparser.default.parseOffice)(bytes, config),
      }))
      .catch((err) => {
        parserPromise = null
        throw err
      })
  }
  return parserPromise
}

/** `{ text, problem, reason? }` for `bytes` (a `Uint8Array`) of the document called `filename`, exactly as the browser's `extractSourceText` gives. Never throws. */
export function extractSourceTextOnServer(filename, bytes, options = {}) {
  return extractSourceText(filename, bytes, { loadParser: options.loadParser ?? loadNodeParser })
}
