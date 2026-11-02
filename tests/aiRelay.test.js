import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALLOW_PRIVATE_ENV_VAR,
  AiRelayError,
  checkTargetUrl,
  isPrivateHost,
  isPrivateIp,
  parseRelayEnvelope,
  privateAddressesAllowed,
} from '../lib/aiRelay.js'
import { withRunningServer, withScratchInstances } from './helpers/lifecycle.js'

// #277 (ADR-0061): the AI relay. The browser holds the architect's AI Providers and keys; `gantry serve`
// forwards each call and must never keep the key, and must refuse private and loopback addresses unless the
// operator opts in with GANTRY_AI_ALLOW_PRIVATE_URLS.

// ---------- which addresses are private ----------

test('loopback, private, link-local, carrier-grade and unspecified IPv4 addresses are private', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
})

test('public IPv4 addresses, including those next to a private range, are not private', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.169.0.1', '11.0.0.1']) {
    assert.equal(isPrivateIp(ip), false, ip)
  }
})

test('IPv6 loopback, unique-local, link-local and unspecified addresses are private, and IPv4-mapped ones follow their IPv4 address', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:192.168.0.5']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
  for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808']) {
    assert.equal(isPrivateIp(ip), false, ip)
  }
})

test('localhost and names that only mean "this network" are private on their face; public names are not judged by name', () => {
  for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'ollama.localhost', 'printer.local', 'db.internal', 'nas.lan', '127.0.0.1', '[::1]']) {
    assert.equal(isPrivateHost(host), true, host)
  }
  for (const host of ['api.openai.com', 'openrouter.ai', '8.8.8.8', 'localhost.example.com']) {
    assert.equal(isPrivateHost(host), false, host)
  }
})

test('the operator opt-in reads GANTRY_AI_ALLOW_PRIVATE_URLS and an explicit option wins over it', () => {
  assert.equal(privateAddressesAllowed(undefined, {}), false)
  assert.equal(privateAddressesAllowed(undefined, { [ALLOW_PRIVATE_ENV_VAR]: '1' }), true)
  assert.equal(privateAddressesAllowed(undefined, { [ALLOW_PRIVATE_ENV_VAR]: 'true' }), true)
  assert.equal(privateAddressesAllowed(undefined, { [ALLOW_PRIVATE_ENV_VAR]: 'no' }), false)
  assert.equal(privateAddressesAllowed(false, { [ALLOW_PRIVATE_ENV_VAR]: '1' }), false)
  assert.equal(privateAddressesAllowed(true, {}), true)
})

test('the refusal names the variable the operator would set', () => {
  assert.throws(
    () => checkTargetUrl('http://localhost:11434'),
    (err) => err instanceof AiRelayError && err.status === 400 && err.code === 'ai_address_refused' && err.message.includes('GANTRY_AI_ALLOW_PRIVATE_URLS')
  )
  assert.doesNotThrow(() => checkTargetUrl('http://localhost:11434', { allowPrivate: true }))
})

test('an address that is not http(s), has no host or carries a password is always refused', () => {
  for (const raw of ['ftp://example.com', 'file:///etc/passwd', 'not a url', '', 'https://user:secret@api.example.com/v1']) {
    assert.throws(() => checkTargetUrl(raw, { allowPrivate: true }), (err) => err instanceof AiRelayError && err.code === 'ai_address_invalid', raw)
  }
})

// ---------- the envelope ----------

test('only GET and POST are forwarded, and only a short list of headers goes with them', () => {
  const parsed = parseRelayEnvelope(
    JSON.stringify({
      url: 'https://api.example.com/v1/models',
      method: 'get',
      headers: { Authorization: 'Bearer k', 'X-Api-Key': 'k2', Host: 'evil', Cookie: 'a=b', 'X-Forwarded-For': '1.2.3.4', 'anthropic-version': '2023-06-01' },
    })
  )
  assert.equal(parsed.method, 'GET')
  assert.deepEqual(parsed.headers, { authorization: 'Bearer k', 'x-api-key': 'k2', 'anthropic-version': '2023-06-01' })
  assert.equal(parsed.body, null)
  assert.throws(() => parseRelayEnvelope(JSON.stringify({ url: 'https://api.example.com', method: 'DELETE' })), (err) => err.code === 'invalid_request')
  assert.throws(() => parseRelayEnvelope(JSON.stringify({ url: 'https://api.example.com', headers: { authorization: 'a\r\nHost: evil' } })), (err) => err.code === 'invalid_request')
  assert.throws(() => parseRelayEnvelope('{nope'), (err) => err.code === 'invalid_json')
  assert.throws(() => parseRelayEnvelope('[]'), (err) => err.code === 'invalid_request')
})

test('a POST body given as JSON is sent as JSON, and a string body is sent as written', () => {
  const asObject = parseRelayEnvelope(JSON.stringify({ url: 'https://api.example.com/x', body: { a: 1 } }))
  assert.equal(asObject.body.toString(), '{"a":1}')
  assert.equal(asObject.headers['content-type'], 'application/json')
  const asString = parseRelayEnvelope(JSON.stringify({ url: 'https://api.example.com/x', body: '{"b":2}', headers: { 'content-type': 'application/json' } }))
  assert.equal(asString.body.toString(), '{"b":2}')
})

// ---------- through a real server ----------

const KEY = 'sk-test-THIS-KEY-MUST-NEVER-BE-KEPT-0123456789'

// A stand-in AI Provider on a loopback port that records what it was sent.
function withFakeAi(handler, fn) {
  const seen = []
  const upstream = createHttpServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(record)
      handler(record, res)
    })
  })
  return new Promise((resolve, reject) => {
    upstream.listen(0, '127.0.0.1', async () => {
      try {
        await fn(`http://127.0.0.1:${upstream.address().port}`, seen)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        upstream.close()
      }
    })
  })
}

function relay(base, envelope) {
  return fetch(`${base}/api/ai/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) })
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(path) : statSync(path).isFile() ? [path] : []
  })
}

test('private and loopback addresses are refused by default, naming the variable, and nothing is called', async () => {
  await withFakeAi(
    (_req, res) => res.end('{}'),
    async (upstreamBase, seen) => {
      await withRunningServer({}, async (base) => {
        const res = await relay(base, { url: `${upstreamBase}/v1/models`, method: 'GET', headers: { authorization: `Bearer ${KEY}` } })
        assert.equal(res.status, 400)
        const body = await res.json()
        assert.equal(body.error, 'ai_address_refused')
        assert.match(body.message, /GANTRY_AI_ALLOW_PRIVATE_URLS/)
        assert.ok(!JSON.stringify(body).includes(KEY))
        assert.equal(seen.length, 0)
        for (const url of ['http://localhost:11434/api/tags', 'http://[::1]:11434/', 'http://10.0.0.5/v1/models', 'http://169.254.169.254/latest/meta-data']) {
          const refused = await relay(base, { url, method: 'GET' })
          assert.equal(refused.status, 400, url)
          assert.equal((await refused.json()).error, 'ai_address_refused', url)
        }
      })
    }
  )
})

test('a public name that resolves to a private address is refused at connect time', async () => {
  await withFakeAi(
    (_req, res) => res.end('{}'),
    async (upstreamBase, seen) => {
      const port = new URL(upstreamBase).port
      const rebind = (_host, _options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }])
      await withRunningServer({ aiRelayLookup: rebind }, async (base) => {
        const res = await relay(base, { url: `http://looks-public.example.test:${port}/v1/models`, method: 'GET' })
        assert.equal(res.status, 400)
        assert.equal((await res.json()).error, 'ai_address_refused')
        assert.equal(seen.length, 0)
      })
      await withRunningServer({ aiRelayLookup: rebind, allowPrivateAiUrls: true }, async (base) => {
        const res = await relay(base, { url: `http://looks-public.example.test:${port}/v1/models`, method: 'GET' })
        assert.equal(res.status, 200)
        assert.equal(seen.length, 1)
      })
    }
  )
})

test('with the operator opt-in, the call is forwarded with the key and the answer comes back', async () => {
  await withFakeAi(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'tracking=1', 'X-Upstream-Secret': 'no' })
      res.end(JSON.stringify({ data: [{ id: 'm1' }], saw: req.url }))
    },
    async (upstreamBase, seen) => {
      for (const serverOptions of [{ allowPrivateAiUrls: true }, { env: { GANTRY_AI_ALLOW_PRIVATE_URLS: '1' } }]) {
        seen.length = 0
        await withRunningServer(serverOptions, async (base) => {
          const res = await relay(base, {
            url: `${upstreamBase}/v1/chat/completions?x=1`,
            method: 'POST',
            headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Host: 'evil.example' },
            body: { model: 'm1', messages: [] },
          })
          assert.equal(res.status, 200)
          assert.equal(res.headers.get('content-type'), 'application/json')
          assert.equal(res.headers.get('set-cookie'), null)
          assert.equal(res.headers.get('x-upstream-secret'), null)
          assert.deepEqual(await res.json(), { data: [{ id: 'm1' }], saw: '/v1/chat/completions?x=1' })
          assert.equal(seen.length, 1)
          assert.equal(seen[0].method, 'POST')
          assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`)
          assert.notEqual(seen[0].headers.host, 'evil.example')
          assert.deepEqual(JSON.parse(seen[0].body), { model: 'm1', messages: [] })
        })
      }
    }
  )
})

test('an upstream error status and body are passed through, and a redirect is not followed', async () => {
  await withFakeAi(
    (req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' })
        res.end()
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Retry-After': '7' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      }
    },
    async (upstreamBase, seen) => {
      await withRunningServer({ allowPrivateAiUrls: true }, async (base) => {
        const rejected = await relay(base, { url: `${upstreamBase}/v1/models`, method: 'GET', headers: { authorization: 'Bearer wrong' } })
        assert.equal(rejected.status, 401)
        assert.equal(rejected.headers.get('retry-after'), '7')
        assert.deepEqual(await rejected.json(), { error: { message: 'invalid api key' } })
        const redirected = await relay(base, { url: `${upstreamBase}/redirect`, method: 'GET' })
        assert.equal(redirected.status, 302)
        assert.equal(seen.length, 2)
      })
    }
  )
})

test('an unreachable AI Provider is a 502 that names the host and nothing from the request', async () => {
  await withRunningServer({ allowPrivateAiUrls: true }, async (base) => {
    const res = await relay(base, { url: 'http://127.0.0.1:1/v1/models', method: 'GET', headers: { authorization: `Bearer ${KEY}` } })
    assert.equal(res.status, 502)
    const body = await res.json()
    assert.equal(body.error, 'ai_unreachable')
    assert.match(body.message, /127\.0\.0\.1:1/)
    assert.ok(!JSON.stringify(body).includes(KEY))
  })
})

test('malformed relay requests are 400s', async () => {
  await withRunningServer({}, async (base) => {
    const notJson = await fetch(`${base}/api/ai/relay`, { method: 'POST', body: '{nope' })
    assert.equal(notJson.status, 400)
    const noUrl = await relay(base, {})
    assert.equal(noUrl.status, 400)
    const wrongMethod = await fetch(`${base}/api/ai/relay`, { method: 'GET' })
    assert.notEqual(wrongMethod.status, 200)
  })
})

test('the key never reaches server storage or logs', async () => {
  // Everything the server could write the key to: its stdout and stderr (console and raw stream writes) and
  // every file under its data directory, checked after calls that succeed, are rejected upstream and fail.
  const logged = []
  const originals = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  }
  const capture = (...args) => logged.push(args.map(String).join(' '))
  await withScratchInstances(async (instancesDir) => {
    await withFakeAi(
      (req, res) => {
        if (req.url.startsWith('/bad')) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'bad key' } }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        }
      },
      async (upstreamBase) => {
        await withRunningServer({ instancesDir, allowPrivateAiUrls: true }, async (base) => {
          console.log = console.error = console.warn = console.info = console.debug = capture
          process.stdout.write = (chunk, ...rest) => (logged.push(String(chunk)), true)
          process.stderr.write = (chunk, ...rest) => (logged.push(String(chunk)), true)
          const responses = []
          try {
            const headers = { authorization: `Bearer ${KEY}`, 'x-api-key': KEY }
            responses.push(await relay(base, { url: `${upstreamBase}/ok`, method: 'GET', headers }))
            responses.push(await relay(base, { url: `${upstreamBase}/bad`, method: 'POST', headers, body: { prompt: 'hello' } }))
            responses.push(await relay(base, { url: 'http://127.0.0.1:1/down', method: 'GET', headers }))
            responses.push(await relay(base, { url: 'http://localhost.example.test:1/x', method: 'GET', headers }))
          } finally {
            Object.assign(console, { log: originals.log, error: originals.error, warn: originals.warn, info: originals.info, debug: originals.debug })
            process.stdout.write = originals.stdout
            process.stderr.write = originals.stderr
          }
          for (const res of responses) {
            const text = await res.text()
            assert.ok(!text.includes(KEY), 'the key came back in a response')
            for (const [name, value] of res.headers) assert.ok(!value.includes(KEY), `the key came back in the ${name} header`)
          }
        })
      }
    )
    assert.ok(!logged.join('\n').includes(KEY), 'the key reached a log')
    for (const file of filesUnder(instancesDir)) {
      assert.ok(!readFileSync(file).includes(KEY), `the key was written to ${file}`)
    }
  })
})
