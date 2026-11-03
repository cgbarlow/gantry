import { chromium } from 'playwright'

// Container-optimised Chromium launch arguments.  In CI (where the CI
// environment variable is set by Azure Pipelines and the ContainerFile),
// Chromium needs these flags to run reliably inside a headless container
// without /dev/shm, a GPU, or a sandbox user namespace.
const CI_ARGS = [
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
]

// Default timeout for Playwright actions (waitForSelector, click, etc.).
// CI containers are significantly slower than developer workstations due
// to unbundled ESM module waterfalls and resource contention, so we use
// a higher default there.
export const DEFAULT_TIMEOUT = process.env.CI ? 30_000 : 10_000

// #72: this file's `DEFAULT_TIMEOUT` is the CI-scaled budget, but ~1,000 call sites across the
// browser suites pass their own literal `{ timeout: 10_000 }` / `5_000` / `2_000`, which silently
// overrides it. On a loaded machine (several agents or a CI container running Chromium and the unbundled
// ESM module waterfall at once) a first paint takes longer than that literal, and whichever test
// happens to hit it fails — a different test each run, in every suite. Rather than rewrite every call
// site (and conflict with every in-flight branch), each *explicit* timeout is multiplied by the same
// factor the default already carries: 3x under CI (30s / 10s), 1x elsewhere. Override with
// PW_TIMEOUT_SCALE. A timeout of 0 (no timeout) and Playwright's own defaults are untouched.
export const TIMEOUT_SCALE = Number(process.env.PW_TIMEOUT_SCALE) || DEFAULT_TIMEOUT / 10_000

const NOT_SCALED_METHODS = new Set(['setDefaultTimeoutNoReply', 'setDefaultNavigationTimeoutNoReply'])
const patched = new WeakSet()

function scaleExplicit(ms) {
  return typeof ms === 'number' && ms > 0 ? Math.round(ms * TIMEOUT_SCALE) : ms
}

// Playwright exposes no hook for this, so it is applied at the two places the client library resolves
// an explicit timeout: `TimeoutSettings` (client-side waiters, and the per-call budget) and
// `Connection.sendMessageToServer` (the `timeout` param the browser-side server enforces). Both
// prototypes are internal, so this is feature-detected and degrades to "no scaling" rather than
// throwing; tests/launchBrowserTimeoutScale.playwright.test.js fails if a Playwright upgrade changes
// the internals and the scaling stops working.
function patchTimeoutScaling(connection, timeoutSettings) {
  if (TIMEOUT_SCALE === 1) return
  const settingsProto = timeoutSettings && Object.getPrototypeOf(timeoutSettings)
  if (settingsProto && !patched.has(settingsProto)) {
    patched.add(settingsProto)
    for (const name of ['_timeout', '_navigationTimeout', '_launchTimeout']) {
      const original = settingsProto[name]
      if (typeof original !== 'function') continue
      settingsProto[name] = function (options) {
        if (options && typeof options.timeout === 'number' && options.timeout > 0) return scaleExplicit(options.timeout)
        return original.call(this, options)
      }
    }
  }
  const connectionProto = connection && Object.getPrototypeOf(connection)
  if (connectionProto && !patched.has(connectionProto) && typeof connectionProto.sendMessageToServer === 'function') {
    patched.add(connectionProto)
    const original = connectionProto.sendMessageToServer
    connectionProto.sendMessageToServer = function (object, method, params, options) {
      if (params && typeof params.timeout === 'number' && params.timeout > 0 && !NOT_SCALED_METHODS.has(method)) {
        params = { ...params, timeout: scaleExplicit(params.timeout) }
      }
      return original.call(this, object, method, params, options)
    }
  }
}

/**
 * Launch a Chromium browser with container-optimised arguments when
 * running in CI, and developer defaults otherwise. Explicit per-call timeouts are scaled by
 * `TIMEOUT_SCALE` (see above).
 */
export async function launchBrowser() {
  const browser = await chromium.launch({
    args: process.env.CI ? CI_ARGS : [],
  })
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async (...args) => {
    const context = await newContext(...args)
    patchTimeoutScaling(browser._connection, context._timeoutSettings)
    return context
  }
  return browser
}
