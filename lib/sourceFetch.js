// #318 (docs/adr/0071): fetches a web address an architect (or an outside agent over MCP) gives as a Source document. Browsers refuse most
// cross-site fetches, so `gantry serve` fetches the bytes and hands them back; the browser then reads the text exactly as for an upload,
// and the document is stored through the ordinary add-document paths. Nothing here stores anything.
//
// Four rules this module must never break:
//   1. **Every hop is checked.** The address as written and every redirect's target go through the shared address check
//      (lib/addressCheck.js), on its face and again on what the name resolves to at connect time, so a public page can't bounce the server
//      into its own network. Private addresses are allowed only by this fetch's own operator setting,
//      GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS, never by the AI relay's; cloud metadata endpoints are refused even then.
//   2. **No credentials for other sites.** Nothing from the architect's request (no cookie, no header, no password) goes out: the request
//      carries a fixed set of headers, and an address with a user name or password in it is refused.
//   3. **The same limits as an upload.** 25 MB, and only the types Gantry reads, plus HTML.
//   4. **Every failure says what to do.** An address that can't be reached, a status error, a time-out, a document over 25 MB, a type
//      Gantry can't read and a page behind a sign-in each have their own message.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { PRIVATE_ADDRESS_SETTINGS, checkAddress, guardedLookup } from './addressCheck.js'
import { MAX_SOURCE_BYTES, defaultSourceTitle, formatBytes, sourceFileExtension, sourceFileKind } from '../web/lib/sourceDocuments.js'

/** The operator's off switch for adding Source documents by address. Uploads are unaffected. */
export const SOURCE_FETCH_DISABLED_ENV_VAR = 'GANTRY_SOURCE_FETCH_DISABLED'

/** The operator's own setting that lets this fetch reach private addresses (an intranet wiki). Never the AI relay's. */
export const SOURCE_FETCH_ALLOW_PRIVATE_ENV_VAR = PRIVATE_ADDRESS_SETTINGS.sourceFetch

/** How long one fetch, redirects included, may take. */
export const SOURCE_FETCH_TIMEOUT_MS = 30 * 1000

/** How many redirects one fetch follows before giving up. */
export const MAX_SOURCE_FETCH_REDIRECTS = 5

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SIGN_IN_STATUSES = new Set([401, 403, 407])

const SAVE_AS_PDF = 'Open it in your browser, save it as a PDF and upload that instead.'

/** A refusal or failure with an HTTP-ish `status` and a stable `code`, so the route maps it to a response and the panel shows its message. */
export class SourceFetchError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message)
    this.name = 'SourceFetchError'
    this.code = code
    this.status = status
  }
}

/** Whether the operator has switched adding by address off: `option` (a test) when given, otherwise GANTRY_SOURCE_FETCH_DISABLED (`1`, `true`, `yes` or `on`). */
export function sourceFetchDisabled(option, env) {
  if (option !== undefined) return option === true
  const raw = env ? env[SOURCE_FETCH_DISABLED_ENV_VAR] : process.env.GANTRY_SOURCE_FETCH_DISABLED
  return typeof raw === 'string' && /^(1|true|yes|on)$/i.test(raw.trim())
}

/** The refusal shown when the off switch is set. */
export const SOURCE_FETCH_OFF_MESSAGE = 'Adding Source documents by web address is switched off on this Gantry server. Save the page as a PDF and upload it instead.'

// What each content type is stored as. An HTML page is kept as its HTML; everything else is a type an upload takes.
const CONTENT_TYPE_EXTENSIONS = {
  'text/html': '.html',
  'application/xhtml+xml': '.html',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/markdown': '.md',
  'text/x-markdown': '.md',
  'text/plain': '.txt',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

// A type that says nothing about what the bytes are: the address's own extension decides.
const UNSPECIFIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/download', 'application/force-download'])

// Where a sign-in usually lives: a path step like /login, or one of the big identity providers.
const SIGN_IN_PATH = /(^|\/)(log-?in|log-?on|sign-?in|auth|authenticate|sso|saml|oauth2?|openid-connect)(\/|$)/i
const SIGN_IN_HOSTS = [/^login\.microsoftonline\.com$/i, /^login\.live\.com$/i, /^accounts\.google\.com$/i, /\.okta\.com$/i, /\.auth0\.com$/i]

/**
 * The extension the fetched bytes are kept under, from the response's content type and, when that says nothing more specific (or is plain
 * text), the address's own extension. `null` when Gantry can't take the type.
 */
export function fetchedExtension(contentType, finalAddress) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  let fromPath = ''
  try {
    fromPath = sourceFileExtension(decodeURIComponent(new URL(finalAddress).pathname.split('/').pop() ?? ''))
  } catch {
    fromPath = ''
  }
  const pathKind = sourceFileKind(`x${fromPath}`)
  if (UNSPECIFIC_TYPES.has(type)) return pathKind ? fromPath : null
  const ext = CONTENT_TYPE_EXTENSIONS[type]
  if (!ext) return null
  // A text file served as text/plain keeps its own extension when it names a text type Gantry reads (.md, .csv, .tsv).
  if (ext === '.txt' && pathKind && ['text', 'spreadsheet'].includes(pathKind) && fromPath !== '.xlsx') return fromPath
  if (ext === '.jpg' && fromPath === '.jpeg') return fromPath
  return ext
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** An HTML page's `<title>`, tidied, or '' when it has none. */
export function htmlTitle(htmlText) {
  const match = String(htmlText ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : ''
}

// The filename a Content-Disposition header gives, if any.
function dispositionFilename(header) {
  const value = String(header ?? '')
  const star = value.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      // fall through to the plain form
    }
  }
  const plain = value.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i)
  return plain ? (plain[2] ?? plain[1]).trim() : ''
}

/**
 * The filename and title a fetched document is offered with: an HTML page is named after its `<title>`; anything else after the
 * Content-Disposition filename or the address's last path step, given `ext` when it lacks it. The store cleans the name as for an upload.
 */
export function suggestedNames({ finalAddress, ext, disposition, pageTitle }) {
  const url = new URL(finalAddress)
  let lastStep = ''
  try {
    lastStep = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
  } catch {
    lastStep = url.pathname.split('/').filter(Boolean).pop() ?? ''
  }
  const fromHeader = dispositionFilename(disposition)
  let base
  if (ext === '.html') base = pageTitle || (lastStep ? lastStep.replace(/\.(html?|php|aspx?|jsp)$/i, '') : url.hostname)
  else base = fromHeader || lastStep || url.hostname
  const filename = sourceFileExtension(base) === ext ? base : `${base}${ext}`
  const title = ext === '.html' && pageTitle ? pageTitle : defaultSourceTitle(filename)
  return { filename, title }
}

// A page that asks for a password, or one a redirect landed on a sign-in path or provider: Gantry never signs in to other sites.
function looksLikeSignIn(finalAddress, ext, bytes) {
  const url = new URL(finalAddress)
  if (SIGN_IN_HOSTS.some((pattern) => pattern.test(url.hostname)) && ext === '.html') return true
  if (ext !== '.html') return false
  if (SIGN_IN_PATH.test(url.pathname)) return true
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 512 * 1024)))
  return /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(head)
}

function signInError(address) {
  return new SourceFetchError(`${address} needs a sign-in, and Gantry never signs in to other sites or takes your cookies or passwords for them. ${SAVE_AS_PDF}`, {
    code: 'sign-in',
    status: 422,
  })
}

function refusedError(host, problem) {
  if (problem === 'metadata') {
    return new SourceFetchError(`Gantry won't fetch ${host}: it is a cloud metadata address, which is never a document.`, { code: 'address-refused', status: 400 })
  }
  return new SourceFetchError(
    `Gantry won't fetch ${host}: it is a private or loopback address, and a server that can reach its own network could be pointed at it. ` +
      `An operator who wants intranet pages allowed sets ${SOURCE_FETCH_ALLOW_PRIVATE_ENV_VAR}=1 on the Gantry server. Otherwise save the page as a PDF and upload it.`,
    { code: 'address-refused', status: 400 }
  )
}

function checkHop(raw, { allowPrivate, first }) {
  const { url, problem } = checkAddress(raw, { allowPrivate, refuseMetadata: true })
  if (problem === 'invalid') {
    throw new SourceFetchError(first ? 'That is not a web address. Paste the whole address, starting https://.' : `The page redirected to "${String(raw).slice(0, 200)}", which is not a web address.`, { code: 'address-invalid', status: 400 })
  }
  if (problem === 'not-http') throw new SourceFetchError(`Gantry only fetches web addresses that start http:// or https://, not ${url.protocol}`, { code: 'address-invalid', status: 400 })
  if (problem === 'credentials') {
    throw new SourceFetchError('That address has a user name or password in it. Gantry never takes passwords for other sites: save the page as a PDF and upload it instead.', { code: 'address-invalid', status: 400 })
  }
  if (problem) throw refusedError(url.host, problem)
  return url
}

function decompressor(encoding) {
  const value = String(encoding ?? '').trim().toLowerCase()
  if (value === 'gzip' || value === 'x-gzip') return createGunzip()
  if (value === 'deflate') return createInflate()
  if (value === 'br') return createBrotliDecompress()
  return null
}

const statusText = (status, message) => `${status}${message ? ` ${message}` : ''}`

/**
 * Fetches `address` and returns `{ address, finalAddress, fetchedAt, contentType, filename, title, bytes }`, `bytes` a `Uint8Array`, or
 * throws a `SourceFetchError`. `options`:
 *   allowPrivate  this fetch's own operator setting (GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS)
 *   lookup        `dns.lookup` unless a test passes its own; every connection's answer is checked
 *   request       `(url, options, onResponse) => ClientRequest`, http(s).request unless a test passes its own
 *   timeoutMs     for the whole fetch, redirects included
 *   maxBytes      MAX_SOURCE_BYTES
 *   now()         the ISO time recorded as `fetchedAt`
 */
export async function fetchSourceAddress(address, options = {}) {
  const { allowPrivate = false, lookup, timeoutMs = SOURCE_FETCH_TIMEOUT_MS, maxBytes = MAX_SOURCE_BYTES, now = () => new Date().toISOString(), userAgent = 'Gantry (Source document fetch)' } = options
  const given = String(address ?? '').trim()
  if (!given) throw new SourceFetchError('Paste a web address to fetch.', { code: 'address-invalid', status: 400 })
  let url = checkHop(given, { allowPrivate, first: true })
  const deadline = Date.now() + timeoutMs
  const lookupFn = guardedLookup({ allowPrivate, refuseMetadata: true, lookupImpl: lookup, refusal: (hostname) => refusedError(hostname, 'private') })

  for (let hop = 0; ; hop++) {
    const response = await requestOnce(url, { lookup: lookupFn, deadline, maxBytes, timeoutMs, userAgent, request: options.request })
    if (REDIRECT_STATUSES.has(response.status) && response.headers.location) {
      if (hop >= MAX_SOURCE_FETCH_REDIRECTS) {
        throw new SourceFetchError(`${given} redirected more than ${MAX_SOURCE_FETCH_REDIRECTS} times. Open it in your browser and paste the address it ends up at.`, { code: 'redirects', status: 502 })
      }
      let next
      try {
        next = new URL(response.headers.location, url).href
      } catch {
        next = response.headers.location
      }
      url = checkHop(next, { allowPrivate, first: false })
      continue
    }
    const finalAddress = url.href
    if (SIGN_IN_STATUSES.has(response.status)) throw signInError(given)
    if (response.status === 404 || response.status === 410) {
      throw new SourceFetchError(`${url.host} answered ${statusText(response.status, response.statusMessage)}: there is no page at ${finalAddress}. Check the address.`, { code: 'status', status: 502 })
    }
    if (response.status >= 400 && response.status < 500) {
      throw new SourceFetchError(`${url.host} refused the request (${statusText(response.status, response.statusMessage)}). Check the address, or save the page as a PDF and upload it.`, { code: 'status', status: 502 })
    }
    if (response.status >= 500) {
      throw new SourceFetchError(`${url.host} had a problem answering (${statusText(response.status, response.statusMessage)}). Try again later, or save the page as a PDF and upload it.`, { code: 'status', status: 502 })
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SourceFetchError(`${url.host} answered ${statusText(response.status, response.statusMessage)}, which is not a document.`, { code: 'status', status: 502 })
    }
    const contentType = String(response.headers['content-type'] ?? '')
    const ext = fetchedExtension(contentType, finalAddress)
    if (!ext) {
      const type = contentType.split(';')[0].trim() || 'a type it does not say'
      throw new SourceFetchError(
        `${finalAddress} is ${type}, which Gantry can't take as a Source document. It takes web pages, Word (.docx), PowerPoint (.pptx), spreadsheets (.xlsx, .csv, .tsv), PDFs, Markdown and text files, and images (.png, .jpg, .gif, .webp).`,
        { code: 'unsupported-type', status: 415 }
      )
    }
    if (response.bytes.byteLength === 0) throw new SourceFetchError(`${finalAddress} came back empty.`, { code: 'empty', status: 502 })
    if (looksLikeSignIn(finalAddress, ext, response.bytes)) throw signInError(given)
    const pageTitle = ext === '.html' ? htmlTitle(new TextDecoder('utf-8').decode(response.bytes.subarray(0, Math.min(response.bytes.length, 256 * 1024)))) : ''
    const { filename, title } = suggestedNames({ finalAddress, ext, disposition: response.headers['content-disposition'], pageTitle })
    return { address: given, finalAddress, fetchedAt: now(), contentType: contentType.split(';')[0].trim().toLowerCase(), filename, title, bytes: response.bytes }
  }
}

// One GET, its body read (and decompressed) up to `maxBytes`. Resolves `{ status, statusMessage, headers, bytes }`.
function requestOnce(url, { lookup, deadline, maxBytes, timeoutMs, userAgent, request }) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now()
    const timedOut = () => new SourceFetchError(`${url.host} didn't answer within ${Math.round(timeoutMs / 1000)} seconds. Try again later, or save the page as a PDF and upload it.`, { code: 'timeout', status: 504 })
    if (remaining <= 0) return reject(timedOut())
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const tooLarge = () => new SourceFetchError(`${url.href} is over the ${formatBytes(maxBytes)} limit for a Source document.`, { code: 'too-large', status: 413 })
    const send = request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest)
    const outbound = send(
      url,
      {
        method: 'GET',
        // A fixed set: nothing from the architect's own request is ever passed on.
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8', 'accept-encoding': 'gzip, deflate, br' },
        lookup,
      },
      (res) => {
        const status = res.statusCode ?? 0
        const headers = res.headers ?? {}
        if (REDIRECT_STATUSES.has(status) || status >= 300) {
          res.resume?.()
          finish(resolve, { status, statusMessage: res.statusMessage, headers, bytes: new Uint8Array() })
          return
        }
        const declared = Number(headers['content-length'])
        if (!decompressor(headers['content-encoding']) && Number.isFinite(declared) && declared > maxBytes) {
          res.destroy?.()
          finish(reject, tooLarge())
          return
        }
        const inflate = decompressor(headers['content-encoding'])
        const body = inflate ? res.pipe(inflate) : res
        const chunks = []
        let size = 0
        body.on('data', (chunk) => {
          size += chunk.length
          if (size > maxBytes) {
            res.destroy?.()
            inflate?.destroy()
            finish(reject, tooLarge())
            return
          }
          chunks.push(chunk)
        })
        body.on('end', () => finish(resolve, { status, statusMessage: res.statusMessage, headers, bytes: new Uint8Array(Buffer.concat(chunks)) }))
        body.on('error', () => finish(reject, new SourceFetchError(`The answer from ${url.host} broke off part way. Try again.`, { code: 'unreachable', status: 502 })))
      }
    )
    const timer = setTimeout(() => {
      outbound.destroy?.()
      finish(reject, timedOut())
    }, remaining)
    outbound.on('error', (err) => {
      if (err instanceof SourceFetchError) return finish(reject, err)
      // The code (ENOTFOUND, ECONNREFUSED...) and the host are the only things reported.
      finish(reject, new SourceFetchError(`Gantry's server couldn't reach ${url.host}${err?.code ? ` (${err.code})` : ''}. Check the address; a page only your own network can reach can't be fetched, so save it as a PDF and upload it.`, { code: 'unreachable', status: 502 }))
    })
    outbound.end()
  })
}
