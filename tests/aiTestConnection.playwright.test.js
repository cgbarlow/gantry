import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// Browser coverage for #278 (parent #238, ADR-0061): Test connection on Global Settings. A real server and relay,
// a real Chromium page, and a real (in-process) stand-in for Anthropic that streams recorded answers.

const fixture = (name) => readFileSync(new URL(`./fixtures/ai-streams/${name}`, import.meta.url), 'utf8')

function withPage(fn) {
  return async (base, ...rest) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      await fn(page, base, pageErrors, ...rest)
      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  }
}

// `script` decides how each POST /v1/messages is answered: { card: 'tool' | 'text', blockUntil, ... }. Requests are
// recorded so a test can see which key each one carried.
function withFakeAnthropic({ goodKeys = ['good'], card = 'tool', failures = [] } = {}, fn) {
  const seen = []
  const queue = [...failures]
  const upstream = createHttpServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const key = req.headers['x-api-key'] ?? null
      seen.push({ method: req.method, url: req.url, key })
      if (!goodKeys.includes(key)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
        return
      }
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'claude-small', max_input_tokens: 200000 }] }))
        return
      }
      if (queue.length) {
        const failure = queue.shift()
        res.writeHead(failure.status, { 'Content-Type': 'application/json', ...(failure.retryAfter ? { 'retry-after': String(failure.retryAfter) } : {}) })
        res.end(JSON.stringify(failure.body))
        return
      }
      const parsed = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (parsed.tools) {
        res.end(card === 'tool' ? fixture('anthropic-tool-call.sse') : fixture('anthropic-text.sse'))
      } else {
        // the image probe: this stand-in "sees" the picture only when it is a tool-capable one
        res.end(fixture('anthropic-text.sse').replace('Hello, ', 'It is ').replace('architect.', 'red.'))
      }
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

async function addAnthropic(page, base, aiBase, { key = 'good' } = {}) {
  await page.goto(`${base}/settings`)
  await page.waitForSelector('#ai-providers')
  await page.click('text=Add AI Provider')
  await page.fill('#ai-provider-name', 'Work Anthropic')
  await page.selectOption('#ai-provider-type', 'anthropic')
  await page.fill('#ai-provider-address', aiBase)
  await page.fill('#ai-provider-key', key)
  await page.fill('#ai-provider-model', 'claude-small')
  await page.click('.ai-provider-dialog .btn.primary')
  await page.waitForSelector('tr[data-ai-provider="Work Anthropic"]')
}

const row = (page) => page.locator('tr[data-ai-provider="Work Anthropic"]')
const testButton = (page) => page.click('tr[data-ai-provider="Work Anthropic"] >> button:text-is("Test")')
const rowText = async (page) => (await row(page).innerText()).replace(/\s+/g, ' ').trim()

test('Test connection shows key, model, "Question cards: native" and "Reads images" in the table, with what each check found', async () => {
  await withFakeAnthropic({}, async (aiBase, seen) => {
    await withRunningServer({ allowPrivateAiUrls: true }, withPage(async (page, base) => {
      await addAnthropic(page, base, aiBase)
      assert.match(await rowText(page), /Untested/)
      await testButton(page)
      await page.waitForSelector('.ai-provider-test-steps')
      assert.match(await rowText(page), /Native Yes Ready/)
      const steps = await page.$$eval('.ai-provider-test-steps li', (lis) => lis.map((li) => [li.dataset.step, li.dataset.ok]))
      assert.deepEqual(steps, [['key', 'true'], ['model', 'true'], ['cards', 'true'], ['images', 'true']])
      assert.match(await page.textContent('.ai-provider-test-steps li[data-step="cards"]'), /native/)
      // the card probe really went out with the tool, through the relay
      assert.ok(seen.filter((r) => r.method === 'POST').length >= 2)
      // the result is stored with the AI Provider and survives a reload
      await page.reload()
      await page.waitForSelector('tr[data-ai-provider="Work Anthropic"]')
      assert.match(await rowText(page), /Native Yes Ready/)
    }))
  })
})

test('a model that answers the probe with plain text is a text fallback, not a failure', async () => {
  await withFakeAnthropic({ card: 'text' }, async (aiBase) => {
    await withRunningServer({ allowPrivateAiUrls: true }, withPage(async (page, base) => {
      await addAnthropic(page, base, aiBase)
      await testButton(page)
      await page.waitForSelector('.ai-provider-test-steps')
      assert.match(await rowText(page), /Text fallback .* Ready/)
      assert.match(await page.textContent('.ai-provider-test-steps li[data-step="cards"]'), /text fallback/)
    }))
  })
})

test('editing the Model after a test marks the AI Provider untested again', async () => {
  await withFakeAnthropic({}, async (aiBase) => {
    await withRunningServer({ allowPrivateAiUrls: true }, withPage(async (page, base) => {
      await addAnthropic(page, base, aiBase)
      await testButton(page)
      await page.waitForSelector('.ai-provider-test-steps')
      await page.click('tr[data-ai-provider="Work Anthropic"] >> button:text-is("Edit")')
      await page.fill('#ai-provider-model', 'claude-big')
      await page.click('.ai-provider-dialog .btn.primary')
      assert.match(await rowText(page), /Untested/)
    }))
  })
})

test('a rejected key shows an inline key prompt, and the test is sent again once a key is entered', async () => {
  await withFakeAnthropic({}, async (aiBase, seen) => {
    await withRunningServer({ allowPrivateAiUrls: true }, withPage(async (page, base) => {
      await addAnthropic(page, base, aiBase, { key: 'wrong' })
      await testButton(page)
      await page.waitForSelector('.ai-recovery-prompt[data-kind="key"]')
      assert.match(await page.textContent('.ai-recovery-prompt'), /rejected the key: invalid x-api-key/)
      assert.equal(await page.isDisabled('.ai-recovery-submit'), true, 'a key has to be entered first')
      await page.fill('.ai-recovery-key', 'good')
      await page.click('.ai-recovery-submit')
      await page.waitForSelector('.ai-provider-test-steps')
      assert.match(await rowText(page), /Native Yes Ready/)
      assert.deepEqual([...new Set(seen.map((r) => r.key))], ['wrong', 'good'])
      // the new key is the AI Provider's key from now on
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gantry:ai-providers'))[0].key)
      assert.equal(stored, 'good')
    }))
  })
})

test('declining to enter a key leaves the test failed with the reason', async () => {
  await withFakeAnthropic({}, async (aiBase) => {
    await withRunningServer({ allowPrivateAiUrls: true }, withPage(async (page, base) => {
      await addAnthropic(page, base, aiBase, { key: 'wrong' })
      await testButton(page)
      await page.waitForSelector('.ai-recovery-prompt[data-kind="key"]')
      await page.click('.ai-recovery-prompt >> button:text-is("Cancel")')
      await page.waitForSelector('.ai-provider-test-summary')
      assert.match(await page.textContent('.ai-provider-test-summary'), /rejected the key/)
      assert.match(await rowText(page), /Untested/)
    }))
  })
})

test('a rate limit or running out of credit offers Retry, and Retry carries on', async () => {
  const failures = [
    { status: 429, retryAfter: 3, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Too many requests' } } },
    { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } },
  ]
  await withFakeAnthropic({ failures }, async (aiBase) => {
    await withRunningServer({ allowPrivateAiUrls: true }, withPage(async (page, base) => {
      await addAnthropic(page, base, aiBase)
      await testButton(page)
      await page.waitForSelector('.ai-recovery-prompt[data-kind="retry"]')
      assert.match(await page.textContent('.ai-recovery-prompt'), /limiting requests.*about 3 seconds/)
      await page.click('.ai-recovery-retry')
      await page.waitForFunction(() => /no credit left/.test(document.querySelector('.ai-recovery-prompt')?.textContent ?? ''))
      assert.match(await page.textContent('.ai-recovery-prompt'), /credit balance is too low/)
      await page.click('.ai-recovery-retry')
      await page.waitForSelector('.ai-provider-test-steps')
      assert.match(await rowText(page), /Native Yes Ready/)
    }))
  })
})
