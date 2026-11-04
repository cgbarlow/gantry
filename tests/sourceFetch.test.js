import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { PRIVATE_ADDRESS_SETTINGS, checkAddress, isMetadataHost, privateAddressesAllowed } from '../lib/addressCheck.js'
import { SourceFetchError, fetchSourceAddress, fetchedExtension, htmlTitle, sourceFetchDisabled, suggestedNames } from '../lib/sourceFetch.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { textPdf } from './helpers/sourceFixtures.js'

// #318 (docs/adr/0071): the Gantry server fetches a web address an architect gives as a Source document. Every hop is checked against
// private addresses with the check the AI relay uses (lib/addressCheck.js), each with its own operator override; every failure says what to
// do; nothing is stored here (the browser and the MCP server store through the ordinary routes, tests/sourceDocuments.test.js).

// ---------- the shared address check ----------

test('each caller has its own private-address setting, and one never answers for the other', () => {
  assert.equal(PRIVATE_ADDRESS_SETTINGS.aiRelay, 'GANTRY_AI_ALLOW_PRIVATE_URLS')
  assert.equal(PRIVATE_ADDRESS_SETTINGS.sourceFetch, 'GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS')
  assert.equal(privateAddressesAllowed(undefined, { GANTRY_AI_ALLOW_PRIVATE_URLS: '1' }, 'sourceFetch'), false)
  assert.equal(privateAddressesAllowed(undefined, { GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS: '1' }, 'aiRelay'), false)
  assert.equal(privateAddressesAllowed(undefined, { GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS: 'yes' }, 'sourceFetch'), true)
  assert.equal(privateAddressesAllowed(undefined, { GANTRY_AI_ALLOW_PRIVATE_URLS: 'on' }), true)
  assert.throws(() => privateAddressesAllowed(undefined, {}, 'nonsense'))
})

test('cloud metadata endpoints are known by address and by name', () => {
  for (const host of ['169.254.169.254', '[fd00:ec2::254]', '::ffff:169.254.169.254', '100.100.100.200', 'metadata.google.internal', 'METADATA.google.internal.']) {
    assert.equal(isMetadataHost(host), true, host)
  }
  for (const host of ['169.254.1.1', 'example.com', '8.8.8.8']) assert.equal(isMetadataHost(host), false, host)
})

test('checkAddress names the problem and leaves the wording to its caller', () => {
  assert.equal(checkAddress('not a url').problem, 'invalid')
  assert.equal(checkAddress('ftp://example.com/x').problem, 'not-http')
  assert.equal(checkAddress('https://a:b@example.com/').problem, 'credentials')
  assert.equal(checkAddress('http://10.0.0.5/wiki').problem, 'private')
  assert.equal(checkAddress('http://10.0.0.5/wiki', { allowPrivate: true }).problem, undefined)
  assert.equal(checkAddress('http://169.254.169.254/latest', { allowPrivate: true, refuseMetadata: true }).problem, 'metadata')
  assert.equal(checkAddress('https://example.com/page').url.href, 'https://example.com/page')
})

test('the off switch reads GANTRY_SOURCE_FETCH_DISABLED, and an explicit option wins', () => {
  assert.equal(sourceFetchDisabled(undefined, {}), false)
  assert.equal(sourceFetchDisabled(undefined, { GANTRY_SOURCE_FETCH_DISABLED: '1' }), true)
  assert.equal(sourceFetchDisabled(undefined, { GANTRY_SOURCE_FETCH_DISABLED: 'no' }), false)
  assert.equal(sourceFetchDisabled(false, { GANTRY_SOURCE_FETCH_DISABLED: '1' }), false)
})

// ---------- names and types ----------

test('the stored type comes from the content type, and the address only when the type says nothing more', () => {
  assert.equal(fetchedExtension('text/html; charset=utf-8', 'https://example.com/docs/api'), '.html')
  assert.equal(fetchedExtension('application/pdf', 'https://example.com/spec'), '.pdf')
  assert.equal(fetchedExtension('text/plain', 'https://example.com/README.md'), '.md')
  assert.equal(fetchedExtension('text/plain', 'https://example.com/notes'), '.txt')
  assert.equal(fetchedExtension('application/octet-stream', 'https://example.com/files/brief.docx'), '.docx')
  assert.equal(fetchedExtension('application/octet-stream', 'https://example.com/files/thing.bin'), null)
  assert.equal(fetchedExtension('application/zip', 'https://example.com/a.zip'), null)
})

test('an HTML page is named after its title; anything else after its file name', () => {
  assert.equal(htmlTitle('<html><head><title>  Rate limits &amp; quotas\n</title></head></html>'), 'Rate limits & quotas')
  assert.deepEqual(suggestedNames({ finalAddress: 'https://example.com/docs/limits', ext: '.html', pageTitle: 'Rate limits' }), { filename: 'Rate limits.html', title: 'Rate limits' })
  assert.deepEqual(suggestedNames({ finalAddress: 'https://example.com/docs/limits.html', ext: '.html', pageTitle: '' }), { filename: 'limits.html', title: 'limits' })
  assert.deepEqual(suggestedNames({ finalAddress: 'https://example.com/files/Spec%20v2.pdf', ext: '.pdf' }), { filename: 'Spec v2.pdf', title: 'Spec v2' })
  assert.deepEqual(suggestedNames({ finalAddress: 'https://example.com/download?id=4', ext: '.pdf', disposition: 'attachment; filename="Brief.pdf"' }), { filename: 'Brief.pdf', title: 'Brief' })
  assert.deepEqual(suggestedNames({ finalAddress: 'https://example.com/', ext: '.pdf' }), { filename: 'example.com.pdf', title: 'example.com' })
})

// ---------- every hop is checked (a fake network, so a "public" name can be served without one) ----------

// `routes` maps an address to a response `{ status, headers, body }`, or to `{ resolvesTo }` for a name whose DNS answer is private. The
// fake request resolves a name with the `lookup` it is handed, exactly as Node does at connect time.
function fakeNetwork(routes) {
  const seen = []
  const request = (url, options, onResponse) => {
    const req = new EventEmitter()
    req.end = () => {
      seen.push(url.href)
      const route = routes[url.href]
      options.lookup(url.hostname, {}, (err) => {
        if (err) return req.emit('error', err)
        if (!route) return req.emit('error', Object.assign(new Error('nope'), { code: 'ENOTFOUND' }))
        const res = new PassThrough()
        res.statusCode = route.status ?? 200
        res.headers = route.headers ?? {}
        onResponse(res)
        res.end(route.body ?? '')
      })
    }
    req.destroy = () => {}
    return req
  }
  const lookup = (hostname, _options, callback) => {
    const route = Object.entries(routes).find(([address]) => new URL(address).hostname === hostname)?.[1]
    callback(null, [{ address: route?.resolvesTo ?? '93.184.216.34', family: 4 }])
  }
  return { request, lookup, seen }
}

const page = (body, headers = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body })

test('redirects are followed and the final address is kept, with every hop checked', async () => {
  const net = fakeNetwork({
    'https://docs.example.com/old': { status: 301, headers: { location: '/new' } },
    'https://docs.example.com/new': { status: 302, headers: { location: 'https://cdn.example.com/page' } },
    'https://cdn.example.com/page': page('<html><head><title>Guide</title></head><body><h1>Guide</h1></body></html>'),
  })
  const fetched = await fetchSourceAddress('https://docs.example.com/old', { request: net.request, lookup: net.lookup, now: () => '2026-11-03T00:00:00.000Z' })
  assert.equal(fetched.address, 'https://docs.example.com/old')
  assert.equal(fetched.finalAddress, 'https://cdn.example.com/page')
  assert.equal(fetched.fetchedAt, '2026-11-03T00:00:00.000Z')
  assert.equal(fetched.contentType, 'text/html')
  assert.equal(fetched.filename, 'Guide.html')
  assert.equal(fetched.title, 'Guide')
  assert.deepEqual(net.seen, ['https://docs.example.com/old', 'https://docs.example.com/new', 'https://cdn.example.com/page'])
})

test('a public page that redirects to a private, loopback or metadata address is refused before that hop is fetched', async () => {
  for (const target of ['http://127.0.0.1:8080/admin', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://wiki.internal/']) {
    const net = fakeNetwork({ 'https://public.example.com/go': { status: 302, headers: { location: target } } })
    await assert.rejects(
      fetchSourceAddress('https://public.example.com/go', { request: net.request, lookup: net.lookup }),
      (err) => err instanceof SourceFetchError && err.code === 'address-refused',
      target
    )
    assert.deepEqual(net.seen, ['https://public.example.com/go'], target)
  }
})

test('a redirect to a public-looking name that resolves to a private address is refused at connect time', async () => {
  const net = fakeNetwork({
    'https://public.example.com/go': { status: 302, headers: { location: 'https://rebind.example.net/x' } },
    'https://rebind.example.net/x': { ...page('<p>secret</p>'), resolvesTo: '192.168.0.10' },
  })
  await assert.rejects(fetchSourceAddress('https://public.example.com/go', { request: net.request, lookup: net.lookup }), (err) => err.code === 'address-refused' && /GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS/.test(err.message))
  const allowed = await fetchSourceAddress('https://public.example.com/go', { request: net.request, lookup: net.lookup, allowPrivate: true })
  assert.equal(allowed.finalAddress, 'https://rebind.example.net/x')
})

test('metadata endpoints stay refused even when private addresses are allowed', async () => {
  await assert.rejects(fetchSourceAddress('http://169.254.169.254/latest/meta-data', { allowPrivate: true }), (err) => err.code === 'address-refused' && /metadata/.test(err.message))
  const net = fakeNetwork({ 'https://public.example.com/go': { status: 302, headers: { location: 'http://metadata.google.internal/computeMetadata/v1/' } } })
  await assert.rejects(fetchSourceAddress('https://public.example.com/go', { request: net.request, lookup: net.lookup, allowPrivate: true }), (err) => err.code === 'address-refused')
})

test('too many redirects, a password in the address and a non-web address are each refused with a reason', async () => {
  const routes = {}
  for (let i = 0; i < 8; i++) routes[`https://loop.example.com/${i}`] = { status: 302, headers: { location: `/${i + 1}` } }
  const net = fakeNetwork(routes)
  await assert.rejects(fetchSourceAddress('https://loop.example.com/0', { request: net.request, lookup: net.lookup }), (err) => err.code === 'redirects')
  await assert.rejects(fetchSourceAddress('https://me:secret@example.com/page'), (err) => err.code === 'address-invalid' && /passwords/.test(err.message))
  await assert.rejects(fetchSourceAddress('file:///etc/passwd'), (err) => err.code === 'address-invalid')
  await assert.rejects(fetchSourceAddress('   '), (err) => err.code === 'address-invalid')
})

test('a sign-in page, by status, by where it lands or by a password box, says to save the page as a PDF', async () => {
  const net = fakeNetwork({
    'https://wiki.example.com/private': { status: 401, headers: {} },
    'https://wiki.example.com/team': { status: 302, headers: { location: 'https://login.microsoftonline.com/common/oauth2' } },
    'https://login.microsoftonline.com/common/oauth2': page('<form>Sign in</form>'),
    'https://wiki.example.com/space': page('<form><input name="u"><input type="password" name="p"></form>'),
  })
  for (const address of ['https://wiki.example.com/private', 'https://wiki.example.com/team', 'https://wiki.example.com/space']) {
    await assert.rejects(fetchSourceAddress(address, { request: net.request, lookup: net.lookup }), (err) => err.code === 'sign-in' && /save it as a PDF/.test(err.message), address)
  }
})

// ---------- against a real server on this machine (allowed by the Source document setting, as an intranet page would be) ----------

function withSite(handler, fn) {
  const site = createHttpServer(handler)
  return new Promise((resolve, reject) => {
    site.listen(0, '127.0.0.1', async () => {
      try {
        await fn(`http://127.0.0.1:${site.address().port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        site.closeAllConnections?.()
        site.close()
      }
    })
  })
}

const SITE = (req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><head><title>Vendor API guide</title></head><body><h1>Limits</h1><p>100 requests a minute.</p></body></html>')
  } else if (req.url === '/spec.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' })
    res.end(Buffer.from(textPdf([['The service must answer within 2 seconds.']])))
  } else if (req.url === '/gzipped') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' })
    res.end(gzipSync('hello from a gzipped page'))
  } else if (req.url === '/missing') {
    res.writeHead(404)
    res.end()
  } else if (req.url === '/broken') {
    res.writeHead(503)
    res.end()
  } else if (req.url === '/archive.zip') {
    res.writeHead(200, { 'Content-Type': 'application/zip' })
    res.end('PK')
  } else if (req.url === '/big') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(64 * 1024) })
    res.end('x'.repeat(64 * 1024))
  } else if (req.url === '/big-chunked') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    for (let i = 0; i < 8; i++) res.write('y'.repeat(8 * 1024))
    res.end()
  } else if (req.url === '/slow') {
    // never answers
  } else {
    res.writeHead(500)
    res.end()
  }
}

test('a page and a PDF are fetched, a gzipped answer is unpacked, and nothing of the request is passed on', async () => {
  const seen = []
  await withSite(
    (req, res) => {
      seen.push(req.headers)
      SITE(req, res)
    },
    async (base) => {
      const html = await fetchSourceAddress(`${base}/page`, { allowPrivate: true })
      assert.equal(html.filename, 'Vendor API guide.html')
      assert.equal(html.title, 'Vendor API guide')
      assert.match(new TextDecoder().decode(html.bytes), /100 requests a minute/)
      const pdf = await fetchSourceAddress(`${base}/spec.pdf`, { allowPrivate: true })
      assert.equal(pdf.filename, 'spec.pdf')
      assert.deepEqual(Buffer.from(pdf.bytes), Buffer.from(textPdf([['The service must answer within 2 seconds.']])))
      const gz = await fetchSourceAddress(`${base}/gzipped`, { allowPrivate: true })
      assert.equal(new TextDecoder().decode(gz.bytes), 'hello from a gzipped page')
      assert.equal(gz.filename, 'gzipped.txt')
      for (const headers of seen) {
        assert.equal(headers.cookie, undefined)
        assert.equal(headers.authorization, undefined)
      }
    }
  )
})

test('a local address is refused without the Source document setting', async () => {
  await withSite(SITE, async (base) => {
    await assert.rejects(fetchSourceAddress(`${base}/page`), (err) => err.code === 'address-refused' && /GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS=1/.test(err.message))
  })
})

test('a status error, an unsupported type, a document over the limit, a time-out and an unreachable host each fail with their own message', async () => {
  await withSite(SITE, async (base) => {
    const fails = (path, code, pattern, options = {}) =>
      assert.rejects(fetchSourceAddress(`${base}${path}`, { allowPrivate: true, ...options }), (err) => err instanceof SourceFetchError && err.code === code && pattern.test(err.message), path)
    await fails('/missing', 'status', /404.*Check the address/)
    await fails('/broken', 'status', /503.*Try again later/)
    await fails('/archive.zip', 'unsupported-type', /application\/zip, which Gantry can't take/)
    await fails('/big', 'too-large', /over the 32 KB limit/, { maxBytes: 32 * 1024 })
    await fails('/big-chunked', 'too-large', /over the 32 KB limit/, { maxBytes: 32 * 1024 })
    await fails('/slow', 'timeout', /didn't answer within/, { timeoutMs: 300 })
  })
  await assert.rejects(fetchSourceAddress('http://127.0.0.1:1/nothing', { allowPrivate: true }), (err) => err.code === 'unreachable' && /couldn't reach 127\.0\.0\.1:1/.test(err.message))
})

// ---------- the route ----------

const fetchRoute = (base, address) => fetch(`${base}/api/sources/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) })

test('POST /api/sources/fetch hands back the bytes, the final address and a suggested name, and stores nothing', async () => {
  await withSite(SITE, (site) =>
    withRunningServer({ allowPrivateSourceUrls: true }, async (base) => {
      const status = await (await fetch(`${base}/api/sources/fetch`)).json()
      assert.deepEqual(status, { enabled: true, maxBytes: 25 * 1024 * 1024 })
      const res = await fetchRoute(base, `${site}/page`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.address, `${site}/page`)
      assert.equal(body.finalAddress, `${site}/page`)
      assert.equal(body.filename, 'Vendor API guide.html')
      assert.equal(body.title, 'Vendor API guide')
      assert.equal(body.contentType, 'text/html')
      assert.ok(!Number.isNaN(new Date(body.fetchedAt).getTime()))
      assert.match(Buffer.from(body.dataBase64, 'base64').toString('utf8'), /100 requests a minute/)
      const missing = await fetchRoute(base, `${site}/missing`)
      assert.equal(missing.status, 502)
      assert.equal((await missing.json()).code, 'status')
    })
  )
})

test('the AI relay setting never opens Source document fetches, and the Source document setting never opens the relay', async () => {
  await withSite(SITE, async (site) => {
    await withRunningServer({ env: { GANTRY_AI_ALLOW_PRIVATE_URLS: '1' } }, async (base) => {
      const res = await fetchRoute(base, `${site}/page`)
      assert.equal(res.status, 400)
      assert.equal((await res.json()).code, 'address-refused')
    })
    await withRunningServer({ env: { GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS: '1' } }, async (base) => {
      assert.equal((await fetchRoute(base, `${site}/page`)).status, 200)
      const relayed = await fetch(`${base}/api/ai/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `${site}/page`, method: 'GET' }) })
      assert.equal(relayed.status, 400)
      assert.equal((await relayed.json()).error, 'ai_address_refused')
    })
  })
})

test('with the off switch set, the route says it is off and refuses to fetch', async () => {
  for (const options of [{ sourceFetchDisabled: true }, { env: { GANTRY_SOURCE_FETCH_DISABLED: '1' } }]) {
    await withRunningServer(options, async (base) => {
      assert.equal((await (await fetch(`${base}/api/sources/fetch`)).json()).enabled, false)
      const res = await fetchRoute(base, 'https://example.com/page')
      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.code, 'source-fetch-off')
      assert.match(body.error, /switched off/)
    })
  }
})
