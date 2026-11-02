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
import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns'

/** What the operator sets to let the relay reach private and loopback addresses. */
export const ALLOW_PRIVATE_ENV_VAR = 'GANTRY_AI_ALLOW_PRIVATE_URLS'

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

const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
blocked.addAddress('::', 'ipv6')
blocked.addAddress('::1', 'ipv6')
blocked.addSubnet('fc00::', 7, 'ipv6')
blocked.addSubnet('fe80::', 10, 'ipv6')
blocked.addSubnet('ff00::', 8, 'ipv6')

// Names that only ever mean "this machine or this network", whatever they resolve to.
const PRIVATE_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa']

/** An error the relay answers with a specific status and a stable `error` code. */
export class AiRelayError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

// `::ffff:7f00:1` and `::ffff:127.0.0.1` are the same IPv4 address in an IPv6 coat. Returns the dotted
// IPv4 form, or null when the address isn't one.
function unmapIPv4(ip) {
  const lower = ip.toLowerCase()
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted) return dotted[1]
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  return null
}

/** True for an IP address literal that is loopback, private, link-local, multicast or otherwise not public. */
export function isPrivateIp(address) {
  const ip = stripBrackets(String(address))
  const family = isIP(ip)
  if (family === 0) return false
  if (family === 6) {
    const mapped = unmapIPv4(ip)
    if (mapped) return blocked.check(mapped, 'ipv4')
    return blocked.check(ip, 'ipv6')
  }
  return blocked.check(ip, 'ipv4')
}

/**
 * True when a host (as written in a URL) is private on its face: a private IP literal, `localhost`, or a
 * name ending in a suffix that only means "this network". A public-looking name is *not* judged here, as
 * only what it resolves to can say; `connectGuard` does that at connect time.
 */
export function isPrivateHost(host) {
  const name = stripBrackets(String(host)).toLowerCase().replace(/\.$/, '')
  if (isIP(name)) return isPrivateIp(name)
  if (name === 'localhost') return true
  return PRIVATE_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * Whether the operator has opted in to private addresses: `option` (a test or embedder) when given,
 * otherwise `GANTRY_AI_ALLOW_PRIVATE_URLS` in the environment (`1`, `true`, `yes` or `on`).
 */
export function privateAddressesAllowed(option, env) {
  if (option !== undefined) return option === true
  const raw = env ? env.GANTRY_AI_ALLOW_PRIVATE_URLS : process.env.GANTRY_AI_ALLOW_PRIVATE_URLS
  return typeof raw === 'string' && /^(1|true|yes|on)$/i.test(raw.trim())
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
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new AiRelayError(400, 'ai_address_invalid', 'The AI Provider address is not a valid URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AiRelayError(400, 'ai_address_invalid', 'The AI Provider address must start with http:// or https://.')
  }
  if (url.username || url.password) {
    throw new AiRelayError(400, 'ai_address_invalid', 'The AI Provider address must not contain a user name or password. Put the key in the Key field.')
  }
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    throw new AiRelayError(400, 'ai_address_refused', refusedMessage(url.host))
  }
  return url
}

// The `lookup` handed to the upstream request: resolve the name ourselves and refuse a private answer, so
// the address that was checked is the address that is connected to.
function guardedLookup(allowPrivate, lookupImpl = dnsLookup) {
  return (hostname, options, callback) => {
    lookupImpl(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err)
      if (!allowPrivate) {
        const bad = addresses.find((a) => isPrivateIp(a.address))
        if (bad) return callback(new AiRelayError(400, 'ai_address_refused', refusedMessage(hostname)))
      }
      if (options && options.all) return callback(null, addresses)
      return callback(null, addresses[0].address, addresses[0].family)
    })
  }
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
