// #318 (docs/adr/0071): the one check of which addresses `gantry serve` may call on someone's behalf, lifted out of the AI relay
// (lib/aiRelay.js, #277) so the relay and the Source document fetch (lib/sourceFetch.js) share it rather than each keeping a copy.
//
// Private, loopback, link-local (cloud metadata lives there) and multicast addresses are refused, because a server that can reach its own
// network could otherwise be pointed at it (SSRF, ADR-0061). The check runs twice: on the address as written (`checkAddress`), and again
// on what the name actually resolves to at connect time (`guardedLookup`), so a public name that points at a private address, or one that
// changes its answer between check and use, is refused too.
//
// Each caller has its own operator override (`PRIVATE_ADDRESS_SETTINGS`), so allowing an intranet wiki for Source documents never opens
// the AI relay to the internal network, and allowing the relay never opens Source documents.
import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns'

/** What the operator sets to let each caller reach private and loopback addresses. */
export const PRIVATE_ADDRESS_SETTINGS = Object.freeze({
  aiRelay: 'GANTRY_AI_ALLOW_PRIVATE_URLS',
  sourceFetch: 'GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS',
})

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

// The cloud providers' instance-metadata endpoints. They are private addresses already; a caller that passes `refuseMetadata` refuses them
// even when its operator has allowed private addresses, since no intranet page an architect means to cite lives there.
const METADATA_ADDRESSES = new Set(['169.254.169.254', 'fd00:ec2::254', '100.100.100.200'])
const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata'])

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
 * only what it resolves to can say; `guardedLookup` does that at connect time.
 */
export function isPrivateHost(host) {
  const name = stripBrackets(String(host)).toLowerCase().replace(/\.$/, '')
  if (isIP(name)) return isPrivateIp(name)
  if (name === 'localhost') return true
  return PRIVATE_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/** True for a cloud instance-metadata endpoint, by IP literal (an IPv4-mapped one included) or by name. */
export function isMetadataHost(host) {
  const name = stripBrackets(String(host)).toLowerCase().replace(/\.$/, '')
  if (isIP(name)) return METADATA_ADDRESSES.has(unmapIPv4(name) ?? name)
  return METADATA_NAMES.has(name)
}

const TRUTHY = /^(1|true|yes|on)$/i

// Each override is read by its literal name, so tests/envVarCheck.test.js can find every `GANTRY_` variable `gantry serve` reads.
function readOverride(setting, env) {
  if (env) return env[PRIVATE_ADDRESS_SETTINGS[setting]]
  return setting === 'sourceFetch' ? process.env.GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS : process.env.GANTRY_AI_ALLOW_PRIVATE_URLS
}

/**
 * Whether the operator has opted `setting` (a key of PRIVATE_ADDRESS_SETTINGS, `aiRelay` by default) in to private addresses: `option`
 * (a test or embedder) when given, otherwise that setting's own environment variable (`1`, `true`, `yes` or `on`). One setting never
 * answers for another.
 */
export function privateAddressesAllowed(option, env, setting = 'aiRelay') {
  if (option !== undefined) return option === true
  if (!PRIVATE_ADDRESS_SETTINGS[setting]) throw new Error(`Unknown private-address setting "${setting}"`)
  const raw = readOverride(setting, env)
  return typeof raw === 'string' && TRUTHY.test(raw.trim())
}

/**
 * Checks an address as written. Returns `{ url }` (the parsed URL) when it may be called, or `{ problem }`, one of `'invalid'` (not a
 * URL), `'not-http'`, `'credentials'` (a user name or password in it), `'private'` or `'metadata'`, for the caller to word in its own
 * terms. `allowPrivate` skips only the private-address refusal; `refuseMetadata` keeps refusing metadata endpoints even then.
 */
export function checkAddress(raw, { allowPrivate = false, refuseMetadata = false } = {}) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return { problem: 'invalid' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: 'not-http', url }
  if (url.username || url.password) return { problem: 'credentials', url }
  if (refuseMetadata && isMetadataHost(url.hostname)) return { problem: 'metadata', url }
  if (!allowPrivate && isPrivateHost(url.hostname)) return { problem: 'private', url }
  return { url }
}

/**
 * The `lookup` to hand an outbound request: resolves the name itself and refuses a private answer (or, with `refuseMetadata`, a metadata
 * one), so the address that was checked is the address that is connected to. `refusal(hostname)` builds the error the request fails
 * with. `lookupImpl` is `dns.lookup` unless a test passes its own.
 */
export function guardedLookup({ allowPrivate = false, refuseMetadata = false, refusal, lookupImpl = dnsLookup }) {
  return (hostname, options, callback) => {
    lookupImpl(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err)
      const bad = addresses.find((a) => (refuseMetadata && isMetadataHost(a.address)) || (!allowPrivate && isPrivateIp(a.address)))
      if (bad) return callback(refusal(hostname))
      if (options && options.all) return callback(null, addresses)
      return callback(null, addresses[0].address, addresses[0].family)
    })
  }
}
