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

/**
 * Launch a Chromium browser with container-optimised arguments when
 * running in CI, and developer defaults otherwise.
 */
export async function launchBrowser() {
  return chromium.launch({
    args: process.env.CI ? CI_ARGS : [],
  })
}
