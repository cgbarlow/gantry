import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// Browser coverage for #277 (parent #238, ADR-0061): AI Providers on Global Settings. A real server, a real
// Chromium page and a real (in-process) stand-in for the AI Provider's HTTP API; nothing mocked at the
// browser or HTTP layer.

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

// A stand-in AI Provider that lists a few models and records each request it gets. `cors` says whether it
// allows another origin (a real Ollama only does once OLLAMA_ORIGINS is set).
function withFakeAiProvider({ cors = false } = {}, fn) {
  const seen = []
  const upstream = createHttpServer((req, res) => {
    seen.push({ method: req.method, url: req.url, origin: req.headers.origin ?? null, authorization: req.headers.authorization ?? null, apiKey: req.headers['x-api-key'] ?? null })
    const corsHeaders = cors
      ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
      : {}
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders })
    if (req.url.startsWith('/v1/models')) {
      res.end(JSON.stringify({ data: [{ id: 'claude-big', max_input_tokens: 1000000 }, { id: 'claude-small', max_input_tokens: 200000 }] }))
    } else if (req.url.startsWith('/api/tags')) {
      res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen3:4b' }] }))
    } else if (req.url.startsWith('/api/show')) {
      res.end(JSON.stringify({ model_info: { 'llama.context_length': 131072 } }))
    } else {
      res.end(JSON.stringify({ data: [{ id: 'plain-model' }] }))
    }
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

async function openSettings(page, base) {
  await page.goto(`${base}/settings`)
  await page.waitForSelector('#ai-providers')
}

async function modelOptions(page) {
  return page.$$eval('#ai-provider-model-options option', (opts) => opts.map((o) => o.value))
}

test('AI Providers are added, shown in the table, marked Default, edited and deleted, and persist across a reload', async () => {
  await withFakeAiProvider({}, async (aiBase, seen) => {
    await withRunningServer({ allowPrivateAiUrls: true }, withPage(async (page, base) => {
      await openSettings(page, base)
      assert.match(await page.textContent('#ai-providers'), /No AI Providers yet/)
      assert.deepEqual(await page.$$eval('.ai-provider-table th', (ths) => ths.map((t) => t.textContent.trim()).filter(Boolean)), [])

      // Add an Anthropic AI Provider: the model list arrives once the address and key are entered.
      await page.click('text=Add AI Provider')
      await page.fill('#ai-provider-name', 'Work Anthropic')
      await page.selectOption('#ai-provider-type', 'anthropic')
      assert.equal(await page.inputValue('#ai-provider-address'), 'https://api.anthropic.com', 'the address is filled in for the type')
      await page.fill('#ai-provider-address', aiBase)
      await page.fill('#ai-provider-key', 'sk-ant-secret-1')
      await page.waitForFunction(() => document.querySelectorAll('#ai-provider-model-options option').length === 2)
      assert.deepEqual(await modelOptions(page), ['claude-big', 'claude-small'])
      assert.deepEqual(seen.map((s) => s.apiKey).filter(Boolean), ['sk-ant-secret-1'], 'the key went on the request to the AI Provider')

      // Choosing a listed model fills in its context window; typing one of your own is allowed too.
      await page.fill('#ai-provider-model', 'claude-small')
      await page.click('.ai-provider-advanced summary')
      await page.waitForFunction(() => document.querySelector('#ai-provider-context-window').value === '200000')
      assert.match(await page.textContent('.ai-provider-advanced .workspace-field-hint'), /Read from Anthropic/)
      await page.fill('#ai-provider-model', 'a-model-nobody-lists')
      await page.fill('#ai-provider-model', 'claude-small')
      await page.click('.ai-provider-dialog .btn.primary')

      let rows = await page.$$eval('.ai-provider-table tbody tr[data-ai-provider]', (trs) => trs.map((t) => t.innerText.replace(/\s+/g, ' ').trim()))
      assert.equal(rows.length, 1)
      assert.match(rows[0], /Work Anthropic Default Anthropic claude-small .* Untested/)
      assert.deepEqual(await page.$$eval('.ai-provider-table th', (ths) => ths.map((t) => t.textContent.trim()).filter(Boolean).slice(0, 6)), ['Name', 'Type', 'Model', 'Question cards', 'Reads images', 'Status'])

      // A second one is not the Default; Make Default moves it.
      await page.click('text=Add AI Provider')
      await page.fill('#ai-provider-name', 'Custom')
      await page.selectOption('#ai-provider-type', 'custom')
      await page.fill('#ai-provider-address', `${aiBase}/v1`)
      await page.fill('#ai-provider-key', 'k2')
      await page.fill('#ai-provider-model', 'my-model') // free text, with or without a list
      await page.click('.ai-provider-dialog .btn.primary')
      assert.equal(await page.locator('.ai-provider-default-stamp').count(), 1)
      assert.match(await page.textContent('tr[data-ai-provider="Work Anthropic"]'), /Default/)
      await page.click('tr[data-ai-provider="Custom"] >> text=Make Default')
      assert.equal(await page.locator('.ai-provider-default-stamp').count(), 1)
      assert.match(await page.textContent('tr[data-ai-provider="Custom"]'), /Default/)

      // The list is the browser's: a reload (and any other page) sees it.
      await page.reload()
      await page.waitForSelector('.ai-provider-table')
      assert.equal(await page.locator('tr[data-ai-provider]').count(), 2)
      assert.match(await page.textContent('tr[data-ai-provider="Custom"]'), /Default/)

      // Edit, then delete.
      await page.click('tr[data-ai-provider="Custom"] >> text=Edit')
      assert.equal(await page.inputValue('#ai-provider-name'), 'Custom')
      await page.fill('#ai-provider-name', 'Custom renamed')
      await page.click('.ai-provider-dialog .btn.primary')
      assert.equal(await page.locator('tr[data-ai-provider="Custom renamed"]').count(), 1)
      await page.click('tr[data-ai-provider="Custom renamed"] >> text=Delete')
      await page.click('text=Yes, delete')
      assert.equal(await page.locator('tr[data-ai-provider]').count(), 1)
      assert.match(await page.textContent('tr[data-ai-provider="Work Anthropic"]'), /Default/, 'deleting the Default hands it to the one that is left')

      // Nothing about it reached the server's storage: the AI Providers are in this browser.
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gantry:ai-providers')))
      assert.equal(stored.length, 1)
      assert.equal(stored[0].key, 'sk-ant-secret-1')
    }))
  })
})

test('validation keeps a half-filled AI Provider from being saved', async () => {
  await withRunningServer({}, withPage(async (page, base) => {
    await openSettings(page, base)
    await page.click('text=Add AI Provider')
    await page.click('.ai-provider-dialog .btn.primary')
    assert.match(await page.textContent('.ai-provider-dialog'), /Give this AI Provider a name/)
    assert.match(await page.textContent('.ai-provider-dialog'), /needs a key/)
    assert.equal(await page.locator('tr[data-ai-provider]').count(), 0)
    // Ollama needs no key.
    await page.fill('#ai-provider-name', 'Local')
    await page.selectOption('#ai-provider-type', 'ollama')
    assert.match(await page.textContent('label[for="ai-provider-key"]'), /optional/i)
    assert.equal(await page.inputValue('#ai-provider-address'), 'http://localhost:11434')
    await page.click('.ai-provider-dialog .btn.primary')
    assert.equal(await page.locator('tr[data-ai-provider="Local"]').count(), 1)
  }))
})

test('a local model on this computer is called by the browser itself, and a blocked request is explained', async () => {
  // Without CORS, the browser refuses: the dialog says to set OLLAMA_ORIGINS.
  await withFakeAiProvider({ cors: false }, async (aiBase, seen) => {
    await withRunningServer({}, withPage(async (page, base) => {
      await openSettings(page, base)
      await page.click('text=Add AI Provider')
      await page.selectOption('#ai-provider-type', 'ollama')
      await page.fill('#ai-provider-address', aiBase)
      // Choosing a local type and an address contacts nothing: the architect presses Load models, so the
      // browser's local-network prompt never arrives as a surprise.
      await page.waitForTimeout(1000)
      assert.equal(seen.length, 0, 'nothing is called until Load models is pressed')
      assert.match(await page.textContent('.ai-provider-model-status'), /Press Load models/)
      await page.click('.ai-provider-load-models')
      await page.waitForFunction(() => /OLLAMA_ORIGINS/.test(document.querySelector('.ai-provider-model-status')?.textContent ?? ''))
      const status = await page.textContent('.ai-provider-model-status')
      assert.ok(status.includes('OLLAMA_ORIGINS'))
      assert.ok(status.includes(new URL(base).origin), 'it names the address to allow')
      assert.ok(seen.every((s) => s.origin === new URL(base).origin), 'the browser made the call itself (it carries the page origin)')

      await page.selectOption('#ai-provider-type', 'lmstudio')
      await page.click('.ai-provider-load-models')
      await page.waitForFunction(() => /LM Studio/.test(document.querySelector('.ai-provider-model-status')?.textContent ?? ''))
      assert.match(await page.textContent('.ai-provider-model-status'), /CORS/)
    }))
  })

  // With CORS allowed, the models arrive straight from the browser, and the context window comes from Ollama.
  await withFakeAiProvider({ cors: true }, async (aiBase, seen) => {
    await withRunningServer({}, withPage(async (page, base) => {
      await openSettings(page, base)
      await page.click('text=Add AI Provider')
      await page.fill('#ai-provider-name', 'Laptop Ollama')
      await page.selectOption('#ai-provider-type', 'ollama')
      assert.equal(await page.isChecked('input[name="ai-provider-runs-on"][value="browser"]'), true, 'This computer is the default')
      await page.fill('#ai-provider-address', aiBase)
      await page.click('.ai-provider-load-models')
      await page.waitForFunction(() => document.querySelectorAll('#ai-provider-model-options option').length === 2)
      assert.deepEqual(await modelOptions(page), ['llama3.1:8b', 'qwen3:4b'])
      await page.fill('#ai-provider-model', 'llama3.1:8b')
      await page.click('.ai-provider-advanced summary')
      await page.waitForFunction(() => document.querySelector('#ai-provider-context-window').value === '131072')
      // Typing your own context window is kept, even when the model changes.
      await page.fill('#ai-provider-context-window', '8192')
      await page.fill('#ai-provider-model', 'qwen3:4b')
      assert.equal(await page.inputValue('#ai-provider-context-window'), '8192')
      await page.click('.ai-provider-dialog .btn.primary')
      assert.match(await page.textContent('tr[data-ai-provider="Laptop Ollama"]'), /Ollama \(this computer\)/)
      assert.ok(seen.length > 0 && seen.every((s) => s.origin === new URL(base).origin), 'every call came from the browser, none from the Gantry server')
    }))
  })
})

test('a local model on the Gantry server goes through the relay, which refuses private addresses unless the operator allows them', async () => {
  await withFakeAiProvider({}, async (aiBase, seen) => {
    await withRunningServer({}, withPage(async (page, base) => {
      await openSettings(page, base)
      await page.click('text=Add AI Provider')
      await page.selectOption('#ai-provider-type', 'lmstudio')
      await page.check('input[name="ai-provider-runs-on"][value="server"]')
      await page.fill('#ai-provider-address', `${aiBase}/v1`)
      await page.waitForFunction(() => /GANTRY_AI_ALLOW_PRIVATE_URLS/.test(document.querySelector('.ai-provider-model-status')?.textContent ?? ''))
      assert.equal(seen.length, 0, 'nothing was called')
    }))
  })
})

