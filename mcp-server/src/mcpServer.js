import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { loadTools } from './toolRegistry.js'
import { SERVER_INSTRUCTIONS } from './instructions.js'

const SERVER_INFO = { name: 'gantry-mcp-server', version: '0.1.0' }

// Builds a fresh McpServer with every discovered tool registered against it, bound to `gantryClient`.
// Called once per incoming HTTP request (see src/index.js) — streamable HTTP's stateless mode has no
// session to hang a long-lived server instance off, and tool modules are import-cached by Node after
// the first call, so this stays cheap.
export async function buildMcpServer({ gantryClient }) {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS })
  const tools = await loadTools()

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      (args) => tool.handler(args ?? {}, { gantryClient })
    )
  }

  return server
}
