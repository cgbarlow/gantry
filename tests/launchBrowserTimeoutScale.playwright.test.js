import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, TIMEOUT_SCALE } from './helpers/launchBrowser.js'

// #72: launchBrowser() multiplies every *explicit* per-call timeout by TIMEOUT_SCALE (3x under CI) so
// the ~1,000 hard-coded `{ timeout: 10_000 }` literals across the browser suites stop undercutting the
// CI-scaled default on a loaded machine. This guards the scaling itself, because it relies on Playwright
// internals: if an upgrade moves them, this fails rather than the scaling silently turning off.

const skip = TIMEOUT_SCALE === 1 ? 'no timeout scaling outside CI (set CI=1 or PW_TIMEOUT_SCALE)' : false

async function elapsedUntilTimeout(fn) {
  const start = Date.now()
  await assert.rejects(fn, /Timeout/)
  return Date.now() - start
}

test('explicit timeouts are scaled: server-side waits (locator, waitForSelector, waitForFunction)', { skip }, async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<p>hi</p>')
    const expected = 1000 * TIMEOUT_SCALE
    for (const fn of [
      () => page.waitForSelector('#never', { timeout: 1000 }),
      () => page.locator('#never').waitFor({ timeout: 1000 }),
      () => page.waitForFunction(() => false, null, { timeout: 1000 }),
    ]) {
      const ms = await elapsedUntilTimeout(fn)
      assert.ok(ms >= expected * 0.9, `expected to wait ~${expected}ms, gave up after ${ms}ms`)
      assert.ok(ms < expected * 2, `waited ${ms}ms, far more than the expected ~${expected}ms`)
    }
  } finally {
    await browser.close()
  }
})

test('explicit timeouts are scaled: client-side waiters (waitForEvent), and 0 stays "no timeout"', { skip }, async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    const expected = 1000 * TIMEOUT_SCALE
    const ms = await elapsedUntilTimeout(() => page.waitForEvent('download', { timeout: 1000 }))
    assert.ok(ms >= expected * 0.9 && ms < expected * 2, `waitForEvent gave up after ${ms}ms, expected ~${expected}ms`)

    // timeout: 0 means "wait forever" — it must not be rewritten into a finite wait.
    const forever = page.waitForSelector('#late', { timeout: 0 })
    await page.waitForTimeout(100)
    await page.setContent('<p id="late">now</p>')
    await forever
  } finally {
    await browser.close()
  }
})

test('default timeouts are left alone (setDefaultTimeout is not multiplied)', { skip }, async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(2000)
    const ms = await elapsedUntilTimeout(() => page.waitForSelector('#never'))
    assert.ok(ms >= 1800 && ms < 2000 * 2, `default timeout of 2000ms gave up after ${ms}ms`)
  } finally {
    await browser.close()
  }
})
