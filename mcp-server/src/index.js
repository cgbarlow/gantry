import { createServer } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createGantryClient } from './gantryClient.js'
import { parseWorkspacePats } from './credentials.js'
import { isAuthorizedAccessToken } from './accessAuth.js'
import { buildMcpServer } from './mcpServer.js'
import { warnAboutUnreadEnvVars } from './envVarCheck.js'

function sendJSON(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJSONBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  return JSON.parse(text)
}

export function createApp({ baseUrl, accessToken, workspacePats, fetchImpl }) {
  const gantryClient = createGantryClient({ baseUrl, workspacePats, ...(fetchImpl ? { fetchImpl } : {}) })

  return async function handleRequest(req, res) {
    if (!req.url || !req.url.startsWith('/mcp')) {
      sendJSON(res, 404, { error: 'not_found' })
      return
    }

    // The MCP-access auth layer: checked before any tool runs, on every request (docs/adr/0043).
    if (!isAuthorizedAccessToken(req, accessToken)) {
      sendJSON(res, 401, { error: 'invalid_or_missing_access_token' })
      return
    }

    let parsedBody
    if (req.method === 'POST') {
      try {
        parsedBody = await readJSONBody(req)
      } catch {
        sendJSON(res, 400, { error: 'invalid_json_body' })
        return
      }
    }

    const server = await buildMcpServer({ gantryClient })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, parsedBody)
  }
}

function main() {
  // #130: the very first thing this process does is name, on stderr, every `GANTRY_`-prefixed
  // variable set in its environment that it does not read. Before the required-variable checks
  // below, deliberately: an operator still carrying a pre-#129 name is about to be told
  // `GANTRY_MCP_BASE_URL` is required, and the line that says the name they set is retired and what
  // replaced it is exactly what turns that into a one-minute fix. Variable *names* only, never
  // values (several are credentials), and warning-only — an unrecognised variable never blocks
  // startup. A correctly configured deployment prints nothing here at all.
  warnAboutUnreadEnvVars(process.env)

  const baseUrl = process.env.GANTRY_MCP_BASE_URL
  const accessToken = process.env.GANTRY_MCP_ACCESS_TOKEN
  const port = Number(process.env.PORT ?? 3100)

  if (!baseUrl) {
    console.error('GANTRY_MCP_BASE_URL is required (the gantry serve deployment this server is a client of)')
    process.exit(1)
  }
  if (!accessToken) {
    console.error('GANTRY_MCP_ACCESS_TOKEN is required (the shared bearer token gating access to this server)')
    process.exit(1)
  }

  let workspacePats
  try {
    workspacePats = parseWorkspacePats(process.env.GANTRY_MCP_WORKSPACE_PATS)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  const handleRequest = createApp({ baseUrl, accessToken, workspacePats })
  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('Unhandled error handling request:', err)
      if (!res.headersSent) sendJSON(res, 500, { error: 'internal_error' })
    })
  })

  httpServer.listen(port, () => {
    console.log(`gantry-mcp-server listening on :${port}, proxying ${baseUrl}`)
  })
}

// Only run the server when executed directly — importing this module (e.g. from tests) must not
// start listening on a port.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main()
}
