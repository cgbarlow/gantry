// Azurite, the Azure Blob emulator, started from npm for the tests that run against a real Blob endpoint
// (#267, #259, docs/adr/0070). It is a devDependency started as a child process, not a service
// container: the unit tests run inside `docker build`'s test stage (ContainerFile), where the build
// cannot reach a sidecar on the agent, but can spawn a child of its own.
//
// `@azure/storage-blob` is held at 12.32.x (package.json) because Azurite 3.37 rejects the newer service
// API versions the 12.34 SDK sends. Raise the two together.
//
// The emulator's account and key are published by Microsoft and well known; they are not a secret.
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AZURITE_ACCOUNT = 'devstoreaccount1'
export const AZURITE_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='

const AZURITE_MAIN = fileURLToPath(new URL('../../node_modules/azurite/dist/src/blob/main.js', import.meta.url))

/** Whether the `azurite` devDependency is installed in this build context. */
export const azuriteAvailable = existsSync(AZURITE_MAIN)

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// The image has no HEALTHCHECK, so poll until the port accepts a connection. Startup is a few seconds
// on an idle machine and over twenty on a busy one, so the allowance is generous.
async function waitUntilListening(port, child, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`azurite exited early (code ${child.exitCode})`)
    if (await canConnect(port)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('azurite did not start listening in time')
}

/**
 * Starts Azurite's Blob service on a free port with in-memory persistence and resolves
 * `{ emulator, stop }`. The emulator is `{ account, key, endpoint, connectionString, containerUrl(name) }`;
 * `endpoint` is the account URL (`http://127.0.0.1:<port>/devstoreaccount1`).
 */
export async function startAzurite() {
  const port = await freePort()
  const location = mkdtempSync(join(tmpdir(), 'gantry-azurite-'))
  const child = spawn(
    process.execPath,
    [AZURITE_MAIN, '--silent', '--inMemoryPersistence', '--blobHost', '127.0.0.1', '--blobPort', String(port)],
    // `--inMemoryPersistence` and `--location` are mutually exclusive, so the scratch folder is only the
    // working directory, in case the emulator drops a file somewhere.
    { stdio: ['ignore', 'ignore', 'pipe'], cwd: location }
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const stop = async () => {
    child.kill('SIGKILL')
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve)))
    rmSync(location, { recursive: true, force: true })
  }
  try {
    await waitUntilListening(port, child)
  } catch (err) {
    await stop()
    throw new Error(`${err.message}${stderr ? `: ${stderr.trim()}` : ''}`)
  }
  const endpoint = `http://127.0.0.1:${port}/${AZURITE_ACCOUNT}`
  return {
    emulator: {
      account: AZURITE_ACCOUNT,
      key: AZURITE_KEY,
      endpoint,
      connectionString: `DefaultEndpointsProtocol=http;AccountName=${AZURITE_ACCOUNT};AccountKey=${AZURITE_KEY};BlobEndpoint=${endpoint};`,
      containerUrl: (name) => `${endpoint}/${name}`,
    },
    stop,
  }
}

// One emulator per test file: starting it takes seconds (many more on a busy machine), far longer than
// any test that uses it. The first `withAzurite` starts it; the file's `after` hook calls `stopAzurite`.
let shared = null

/** Runs `fn(emulator)` against this file's shared Azurite, starting it on first use. */
export async function withAzurite(fn) {
  shared ??= startAzurite()
  const { emulator } = await shared
  return fn(emulator)
}

/** Stops this file's shared Azurite, if one was started. */
export async function stopAzurite() {
  if (!shared) return
  const running = shared
  shared = null
  await (await running).stop()
}
