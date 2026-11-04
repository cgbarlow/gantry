// #277 (parent #238, docs/adr/0061-ai-providers-belong-to-the-browser.md): the AI relay. An architect's AI
// Providers and their keys live in the browser. Every AI call except a local model running on the
// architect's own computer is forwarded by `gantry serve`, because a browser can't call most AI
// Providers directly (CORS) and shouldn't hold the call logic twice.
//
// Three rules this module must never break:
//   1. **The key is never kept.** It arrives in the request envelope, goes out on the one upstream
//      request, and is gone. Nothing here writes it to disk, to a log, to an error message or to a
//      response. The only things that touch the envelope after parsing are the upstream request and,
//      for a refusal, the *address* that was refused (never a header).
//   2. **Private and loopback addresses are refused** unless the operator sets
//      `GANTRY_AI_ALLOW_PRIVATE_URLS`. Otherwise a hosted Gantry could be pointed at its own internal
//      network (an SSRF vector, ADR-0061). The check runs twice: on the address as written, and again on
//      what the name actually resolves to at connect time, so a public name that points at a private
//      address (or one that changes its answer between check and use) is refused too.
//   3. **No redirects are followed.** A redirect is passed back as-is. Following one would let a public
//      address bounce the relay onto a private one after the check.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { PRIVATE_ADDRESS_SETTINGS, checkAddress, guardedLookup as sharedGuardedLookup, isPrivateHost, isPrivateIp, privateAddressesAllowed as sharedPrivateAddressesAllowed } from './addressCheck.js'

// #318: which addresses are private is decided by lib/addressCheck.js, shared with the Source document fetch. Re-exported here so the
// relay's callers and tests keep their names.
export { isPrivateHost, isPrivateIp }

/** What the operator sets to let the relay reach private and loopback addresses. */
export const ALLOW_PRIVATE_ENV_VAR = PRIVATE_ADDRESS_SETTINGS.aiRelay

/** Largest request envelope the relay accepts (a prompt with a few images in it). */
export const MAX_RELAY_BODY_BYTES = 25 * 1024 * 1024

/** How long one upstream call may take before the relay gives up on it. */
export const RELAY_TIMEOUT_MS = 5 * 60 * 1000

const METHODS = new Set(['GET', 'POST'])

// Only these request headers are forwarded. The envelope is caller-supplied, so anything not on this
// list (Host, Cookie, X-Forwarded-*, Content-Length...) is dropped rather than trusted.
const FORWARDED_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
  'accept',
  'openai-organization',
  'http-referer',
  'x-title',
])

// Only these response headers come back. The status and body always do.
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'retry-after']

/** An error the relay answers with a specific status and a stable `error` code. */
export class AiRelayError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Whether the operator has opted in to private addresses: `option` (a test or embedder) when given,
 * otherwise `GANTRY_AI_ALLOW_PRIVATE_URLS` in the environment (`1`, `true`, `yes` or `on`). The Source document
 * fetch's own setting never answers for the relay (lib/addressCheck.js).
 */
export function privateAddressesAllowed(option, env) {
  return sharedPrivateAddressesAllowed(option, env, 'aiRelay')
}

function refusedMessage(host) {
  return (
    `This Gantry server won't call ${host}: it is a private or loopback address. ` +
    `A server that can reach its own network could be pointed at it, so this is off by default. ` +
    `An operator who wants it allowed sets ${ALLOW_PRIVATE_ENV_VAR}=1 on the Gantry server. ` +
    `For a model running on your own computer, choose "This computer" for where it runs instead.`
  )
}

/**
 * Validates the address a call is aimed at. Returns the parsed URL, or throws an `AiRelayError` (400).
 * `allowPrivate` skips only the private-address refusals; a malformed or non-HTTP address is always refused.
 */
export function checkTargetUrl(raw, { allowPrivate = false } = {}) {
  const { url, problem } = checkAddress(raw, { allowPrivate })
  if (problem === 'invalid') throw new AiRelayError(400, 'ai_address_invalid', 'The AI Provider address is not a valid URL.')
  if (problem === 'not-http') throw new AiRelayError(400, 'ai_address_invalid', 'The AI Provider address must start with http:// or https://.')
  if (problem === 'credentials') {
    throw new AiRelayError(400, 'ai_address_invalid', 'The AI Provider address must not contain a user name or password. Put the key in the Key field.')
  }
  if (problem === 'private') throw new AiRelayError(400, 'ai_address_refused', refusedMessage(url.host))
  return url
}

// The `lookup` handed to the upstream request: resolve the name ourselves and refuse a private answer, so
// the address that was checked is the address that is connected to.
function guardedLookup(allowPrivate, lookupImpl) {
  return sharedGuardedLookup({ allowPrivate, lookupImpl, refusal: (hostname) => new AiRelayError(400, 'ai_address_refused', refusedMessage(hostname)) })
}

/**
 * Parses the relay envelope: `{ url, method?, headers?, body? }`. Returns the validated pieces or throws an
 * `AiRelayError`. `body` may be a string (sent as is) or any JSON value (sent as JSON).
 */
export function parseRelayEnvelope(raw, { allowPrivate = false } = {}) {
  let envelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    throw new AiRelayError(400, 'invalid_json', 'Invalid JSON body')
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new AiRelayError(400, 'invalid_request', 'The relay request must be a JSON object with a "url".')
  }
  const url = checkTargetUrl(envelope.url, { allowPrivate })
  const method = String(envelope.method ?? 'POST').toUpperCase()
  if (!METHODS.has(method)) {
    throw new AiRelayError(400, 'invalid_request', `The relay only forwards GET and POST, not ${method}.`)
  }
  const headers = {}
  if (envelope.headers !== undefined && envelope.headers !== null) {
    if (typeof envelope.headers !== 'object' || Array.isArray(envelope.headers)) {
      throw new AiRelayError(400, 'invalid_request', '"headers" must be an object.')
    }
    for (const [name, value] of Object.entries(envelope.headers)) {
      const lower = name.toLowerCase()
      if (!FORWARDED_REQUEST_HEADERS.has(lower)) continue
      if (typeof value !== 'string' || /[\r\n]/.test(value)) {
        throw new AiRelayError(400, 'invalid_request', `The "${lower}" header must be a single-line string.`)
      }
      headers[lower] = value
    }
  }
  let body = null
  if (envelope.body !== undefined && envelope.body !== null && method === 'POST') {
    body = Buffer.from(typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body), 'utf8')
    if (!headers['content-type'] && typeof envelope.body !== 'string') headers['content-type'] = 'application/json'
  }
  return { url, method, headers, body }
}

/**
 * Forwards one parsed envelope to its AI Provider and streams the answer back on `res`. Resolves once the
 * response has been fully written (or the failure answered); never rejects.
 */
export function forwardAiRequest({ url, method, headers, body }, res, { allowPrivate = false, lookup, timeoutMs = RELAY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }
    const fail = (status, code, message) => {
      if (res.headersSent) {
        res.destroy()
      } else {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ error: code, message }))
      }
      done()
    }

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const outbound = { ...headers }
    if (body) outbound['content-length'] = String(body.length)
    const upstream = send(
      url,
      { method, headers: outbound, lookup: guardedLookup(allowPrivate, lookup), timeout: timeoutMs },
      (upstreamRes) => {
        const forwarded = { 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
        for (const name of FORWARDED_RESPONSE_HEADERS) {
          if (upstreamRes.headers[name]) forwarded[name] = upstreamRes.headers[name]
        }
        res.writeHead(upstreamRes.statusCode ?? 502, forwarded)
        upstreamRes.on('error', () => {
          res.destroy()
          done()
        })
        upstreamRes.on('end', done)
        upstreamRes.pipe(res)
      }
    )
    upstream.on('timeout', () => {
      upstream.destroy(new Error('timeout'))
      fail(504, 'ai_timeout', `${url.host} did not answer in time.`)
    })
    upstream.on('error', (err) => {
      if (err instanceof AiRelayError) return fail(err.status, err.code, err.message)
      if (err.message === 'timeout') return // already answered by the timeout handler
      // The code (ECONNREFUSED, ENOTFOUND...) and the host:port are the only things reported: nothing from
      // the request, so nothing that could carry a key.
      fail(502, 'ai_unreachable', `Gantry's server could not reach ${url.host}${err.code ? ` (${err.code})` : ''}.`)
    })
    res.on('close', () => {
      if (!settled) upstream.destroy()
      done()
    })
    if (body) upstream.write(body)
    upstream.end()
  })
}
