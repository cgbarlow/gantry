#!/usr/bin/env node
// #368: the two screenshots README.md shows, captured from a real server and a real Chromium page so the next refresh is one command:
//
//   node scripts/capture-readme-screenshots.mjs
//
// It writes docs/images/readme-ai-interview.png and docs/images/readme-definitions-page.png. The server runs on a scratch copy of the
// bundled Examples workspace (workspaces/examples), so the checked-out examples are never written to. No live AI is used: a stand-in for
// Anthropic's Messages API plays one scripted turn of the interview (an opening summary and a round of question cards), the same way the
// AI interview's browser tests do (tests/helpers/interviewStandIn.js).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { launchBrowser } from '../tests/helpers/launchBrowser.js'
import { anthropicReply } from '../tests/helpers/interviewStandIn.js'

const VIEWPORT = { width: 1440, height: 900 }
const IMAGES_DIR = join('docs', 'images')
const SLUG = 'gantry'
const MODEL = 'claude-sonnet-4-5'

// Source documents for the `gantry` example: the files its hosting proposal was written from, taken from this repository as they are now.
const SOURCES = [
  { from: 'README.md', filename: 'Gantry README.md', title: 'Gantry README' },
  { from: 'docs/adr/0005-instance-data-in-external-ado-repo.md', filename: 'ADR-0005 Instance data in an Azure DevOps repository.md', title: 'ADR-0005 Instance data in an Azure DevOps repository' },
  { from: 'azure-pipelines.release.yml', filename: 'Release pipeline.txt', title: 'Release pipeline' },
  { from: 'ContainerFile', filename: 'ContainerFile.txt', title: 'ContainerFile' },
]

const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })

// The AI's one turn: what it found, then a round of question cards about what the documents leave open.
const OPENING =
  'I read the four Source documents against the saved SOAP. The problem, the requirements and the release flow are covered. Two things the business case needs are not settled: how the registry\'s storage is mounted, and which profile Production runs on.'

const CARDS = [
  {
    id: 'storage-mount',
    kind: 'missing',
    header: 'Registry storage',
    question: 'How should the Azure Files share that holds the workspace registry be mounted?',
    field: 'solution-definition.high-level-solution-overview',
    options: [
      { label: 'NFS', description: 'Locked to the virtual network, with no key to rotate.' },
      { label: 'SMB', description: 'A storage-account key, held as a secret.' },
    ],
    recommended: 'NFS',
    why: 'R1 keeps the service off the public network, and NFS keeps its storage there too, with no key to leak or rotate.',
    source: { document: 'gantry-readme', location: 'Persistence' },
  },
  {
    id: 'workload-profile',
    kind: 'disagreement',
    header: 'Production profile',
    question: 'Should Production run on the Consumption profile or a small Dedicated workload profile?',
    field: 'team-and-estimates.estimates',
    options: [
      { label: 'Consumption', description: 'Pay per use, with cold starts after idle periods.' },
      { label: 'Dedicated', description: 'A fixed monthly cost, with two replicas kept warm.' },
    ],
    recommended: 'Dedicated',
    why: 'R4 asks Production to survive the loss of a replica with no operator action, which needs two replicas kept warm.',
  },
]

const script = (body) => (body.messages.length === 1 ? { text: OPENING, tools: [ask('round-1', CARDS)] } : { text: 'Noted.' })

function startFakeAnthropic() {
  const upstream = createHttpServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: MODEL, max_input_tokens: 200000 }] }))
        return
      }
      // The stand-in's token counts are tiny; report a turn the size a real one is, so the run plan's token figures look like a real run's.
      const reply = anthropicReply(script(JSON.parse(raw))).replace('"input_tokens":10', '"input_tokens":46820').replace('"output_tokens":5', '"output_tokens":1312')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(reply)
    })
  })
  return new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(upstream)))
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, host, () => resolve(server.address().port))
  })
}

async function addSources(base) {
  for (const source of SOURCES) {
    const text = readFileSync(source.from, 'utf8')
    const res = await fetch(`${base}/api/instance/sources?slug=${SLUG}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: source.filename, title: source.title, dataBase64: Buffer.from(text).toString('base64'), text, uploadedBy: 'c.barlow' }),
    })
    if (res.status !== 201) throw new Error(`Adding ${source.filename} failed: ${res.status} ${await res.text()}`)
  }
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'gantry-readme-shots-'))
  let server
  let upstream
  let browser
  try {
    cpSync(join('workspaces', 'examples'), join(tmpDir, 'examples'), { recursive: true })
    mkdirSync(IMAGES_DIR, { recursive: true })

    upstream = await startFakeAnthropic()
    const aiBase = `http://127.0.0.1:${upstream.address().port}`
    server = createServer({ instancesDir: tmpDir, migrateWorkspacesOnStart: true, allowPrivateAiUrls: true })
    const base = `http://localhost:${await listen(server)}`
    await addSources(base)

    browser = await launchBrowser()
    const page = await browser.newPage({ viewport: VIEWPORT })
    page.setDefaultTimeout(30_000)
    const passed = { status: 'passed', testedAt: '2026-11-12T00:00:00Z', questionCards: 'native', readsImages: true, steps: [], message: 'ok' }
    const providers = [{ id: 'anthropic', name: 'Anthropic', type: 'anthropic', address: aiBase, key: 'stand-in', model: MODEL, contextWindow: 200000, isDefault: true, test: passed }]
    await page.addInitScript((value) => localStorage.setItem('gantry:ai-providers', value), JSON.stringify(providers))

    // 1) The `gantry` example's SOAP Stage on the Interview page: Source documents on the left, the AI's opening and its first round of cards in
    // the centre, the live draft on the right.
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.waitForSelector('[data-testid="source-documents-list"] [data-source-id]')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-round"]')
    await page.waitForTimeout(800)
    // Show the conversation from the AI's opening, not scrolled to its end.
    await page.locator('[data-testid="interview-msg"][data-who="ai"]').first().evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(300)
    await shot(page, 'readme-ai-interview.png')

    // 2) The Definitions page on design v4, published, in Map view, with the Library panel showing the other bundled definition.
    // #371: the whole Map now fits the window, so the Library panel is below it: the picture runs from just above the toolbar, down the
    // page, to the end of the Library's list of Stages.
    await page.goto(`${base}/definitions`)
    await page.waitForSelector('.defn-viewer')
    await page.getByRole('button', { name: 'Map', exact: true }).click()
    await page.waitForSelector('.defn-logo-preview')
    await page.waitForSelector('.defn-library-group')
    await page.waitForTimeout(800)
    const box = (selector) => page.locator(selector).first().evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY }
    })
    const top = Math.max(0, Math.floor((await box('.defn-toolbar')).top) - 12)
    const bottom = Math.ceil((await box('.defn-library-group')).bottom) + 12
    await shot(page, 'readme-definitions-page.png', { fullPage: true, clip: { x: 0, y: top, width: VIEWPORT.width, height: bottom - top } })

    console.log('README screenshots captured.')
  } finally {
    await browser?.close().catch(() => {})
    server?.close()
    upstream?.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function shot(page, name, options = {}) {
  const out = join(IMAGES_DIR, name)
  await page.screenshot({ path: out, ...options })
  console.log(`captured ${out}`)
}

main().catch((err) => {
  console.error('capture-readme-screenshots failed:', err)
  process.exit(1)
})
