# Gantry MCP server

An MCP (Model Context Protocol) server that lets an AI agent do everything gantry's web UI does —
author definitions, create and progress workspaces/instances, request approvals — over MCP tools,
speaking streamable HTTP.

It is a thin HTTP client of one already-running `gantry serve` instance: every tool call goes
through `src/gantryClient.js`, which calls that instance's own `/api/*` routes with the same
per-request Workspace PAT auth the browser uses (`docs/adr/0038`). This package holds no gantry
internals of its own. See `../docs/adr/0043-mcp-server-is-a-separate-render-hosted-http-client.md`
for the full architecture decision.

## Running

```sh
npm install
cp .env.example .env   # then edit it
node --env-file=.env src/index.js
```

Or via Docker:

```sh
docker build -t gantry-mcp-server .
docker run -p 3100:3100 --env-file .env gantry-mcp-server
```

The server listens on `/mcp` for streamable HTTP MCP connections.

## Configuration

| Env var | Required | Meaning |
| --- | --- | --- |
| `GANTRY_BASE_URL` | yes | The `gantry serve` deployment this server is a client of. |
| `GANTRY_MCP_ACCESS_TOKEN` | yes | Single shared bearer token gating access to this server. Sent by the MCP client as `Authorization: Bearer <token>`. Single-tenant — there is no OAuth in this phase. |
| `GANTRY_WORKSPACE_PATS` | no (defaults to `{}`) | JSON object mapping workspace id -> Personal Access Token, for every Provider-backed workspace this server needs to act on. A server-directory workspace needs no entry. |
| `PORT` | no (defaults to `3100`) | Port to listen on. |

## Credential model

Two independent auth layers, matching `docs/adr/0043`:

1. **MCP access** — the bearer token above, checked on every request before any tool runs.
2. **Gantry credential** — resolved per call, per workspace, by `gantryClient.request()`:
   - A Provider-backed workspace with an entry in `GANTRY_WORKSPACE_PATS` gets that PAT attached as
     HTTP Basic auth (empty username, PAT as password) — identical to what the browser sends.
   - A server-directory workspace gets no `Authorization` header at all.
   - A Provider-backed workspace **missing** from `GANTRY_WORKSPACE_PATS` gets a structured tool
     error (`missing_workspace_pat`) naming the workspace and the env var to fix — the actual
     mutating action is never sent to `gantry serve`.

No PAT is ever accepted as a tool argument for an *existing* workspace, and none is ever included in
a tool's response.

## Adding a tool

Add a new `src/tools/<cluster>.tools.js` file exporting a `tools` array:

```js
export const tools = [
  {
    name: 'my_tool',
    description: '1. What it does. 2. What it takes. 3. What it returns.',
    inputSchema: { someArg: z.string() }, // a Zod raw shape
    handler: async (args, { gantryClient }) => { /* ... */ },
  },
]
```

`src/toolRegistry.js` auto-discovers every `*.tools.js` file under `src/tools/` — no shared
registration list to edit, so independent tool clusters never collide on the same file.

Every tool handler must go through `gantryClient.request()` (never call `fetch` directly), and
return `okResult()` / `errorResult()` / `credentialErrorResult()` from `src/toolResult.js`.

## Testing

```sh
npm test
```

Every test mocks at the HTTP-client seam (`fetchImpl` / a stubbed global `fetch`) — no live
`gantry serve` process is started by this package's tests.
