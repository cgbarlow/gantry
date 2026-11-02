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

> **Breaking change — action required on upgrade (#129).** Two environment variables were renamed to
> carry the `GANTRY_MCP_` prefix, so the prefix alone answers "which service reads this":
>
> | Old name | New name |
> | --- | --- |
> | `GANTRY_BASE_URL` | `GANTRY_MCP_BASE_URL` |
> | `GANTRY_WORKSPACE_PATS` | `GANTRY_MCP_WORKSPACE_PATS` |
>
> **There are no aliases** — the old names are not read at all. Rename them on this service (Render
> env group, `.env`, or wherever you set them) before deploying, or the server exits at startup
> complaining that `GANTRY_MCP_BASE_URL` is missing, and every Provider-backed workspace fails with
> `missing_workspace_pat`.
>
> The old names read as though they belonged to the `gantry serve` web service, which is a *separate*
> deployment reading a *separate* set of variables. Setting them there did nothing, silently. Keeping
> an alias would leave the confusable name in circulation, which is the problem being fixed — the same
> call made for `GANTRY_BOOTSTRAP_PATS` -> `GANTRY_SHARED_WORKSPACE_PATS` in gantry 0.8.0-beta.

| Env var | Required | Meaning |
| --- | --- | --- |
| `GANTRY_MCP_BASE_URL` | yes | The `gantry serve` deployment this server is a client of. |
| `GANTRY_MCP_ACCESS_TOKEN` | yes | Single shared bearer token gating access to this server. Sent by the MCP client as `Authorization: Bearer <token>`. Single-tenant — there is no OAuth in this phase. |
| `GANTRY_MCP_WORKSPACE_PATS` | no (defaults to `{}`) | JSON object mapping workspace id -> Personal Access Token, for every Provider-backed workspace this server needs to act on. A server-directory workspace needs no entry. |
| `PORT` | no (defaults to `3100`) | Port to listen on. |

## Credential model

Two independent auth layers, matching `docs/adr/0043`:

1. **MCP access** — the bearer token above, checked on every request before any tool runs.
2. **Gantry credential** — resolved per call, per workspace, by `gantryClient.request()`:
   - A Provider-backed workspace with an entry in `GANTRY_MCP_WORKSPACE_PATS` gets that PAT attached as
     HTTP Basic auth (empty username, PAT as password) — identical to what the browser sends.
   - A server-directory workspace gets no `Authorization` header at all.
   - A Provider-backed workspace **missing** from `GANTRY_MCP_WORKSPACE_PATS` gets a structured tool
     error (`missing_workspace_pat`) naming the workspace and the env var to fix — the actual
     mutating action is never sent to `gantry serve`.

No PAT is ever accepted as a tool argument for an *existing* workspace, and none is ever included in
a tool's response.

## Saving content safely: the stage version

Two writers can be on one stage at once: an architect in the editor, a colleague, another agent. So a save
checks what changed since the writer read it (`docs/adr/0068`).

- `get_instance` returns `stageVersion`, a fingerprint of every Field's content on the stage. It follows
  Field content only, so an uploaded Asset or a render leaves it unchanged.
- `update_instance_modules` takes it as `stageVersion` and passes it to gantry serve as `baseVersion`. When it
  still matches, the call saves and returns the stage's new `stageVersion`.
- When the stage has changed since, **nothing is saved** and the call fails with `code: "stage_changed"`, the
  stage's new `stageVersion` and `differingFields`: the Fields in the call that are saved differently now, as
  `moduleId.fieldId` (a custom section is `moduleId."Its title"`). The agent re-reads with `get_instance`,
  settles any difference with the architect, and saves again with the new version. The saved stage itself is
  not echoed in the failure; `get_instance` is the one place to read it.
- With no `stageVersion` the call saves as it did before the check, so existing agents keep working, and the
  response carries `overwrittenFields`: every Field the call overwrote (it held content and now holds something
  else). Requiring the version comes with outside agent sessions (ADR-0067).

The comparison itself lives in gantry serve, so it is the same in every workspace kind.

## Source documents, decisions logs and Reviewed copies

The AI interview adds three kinds of file to an Instance. Following `docs/adr/0043` (the MCP server does everything the web
UI does) and `docs/adr/0067`, an outside agent can read all of them and upload two of them. Read what the architect gave Gantry
before drafting, so figures and names come from a document and not from the agent.

| Tool | What it does |
| --- | --- |
| `list_source_documents` | The Instance's Source documents: id, title, filename, size, whether text was read, and which are `replacedBy` a newer upload or `removed`. |
| `read_source_document` | One document's committed extracted text, a `page` at a time (a PDF by its own page numbers; anything else in sections of about 20,000 characters). A picture comes back as an image block. A document with no text says why. |
| `upload_source_document` | Adds a document under the browser's rules: the same file types, 25 MB, one commit on the current stage's branch on an Azure DevOps or GitHub workspace, an optional `replaces` link, the same manifest entry. |
| `read_decisions_log` | A stage's decisions log (or `allStages`). Server, Azure DevOps and GitHub workspaces; GitLab and Atlassian answer 400 until their module Save lands. |
| `list_reviewed_copies` | The Reviewed copies brought in to the Instance. |
| `read_reviewed_copy` | One copy's comment threads and tracked changes, grouped by the Field each traces to (with `mode` and `notice` when they were placed by matching text). |
| `upload_reviewed_copy` | Brings in one or more `.docx` Reviewed copies. A document with no `gantry-*` properties is refused with the same message the browser shows. |

`get_instance` also returns `outOfDate`: the Fields that drew on a Source document that has since been removed, replaced or read
again with different text (or that cite one with `source:<id>`), with a reason for each. It is worked out by gantry serve from the
manifest, the decisions logs and the saved content each time, so it is the same in every workspace kind. If it can't be worked out
the response carries `outOfDateError` and the instance is still returned.

**Uploads are read on the server.** In the browser the text is read out of a document before it is sent. There is no browser here, so
`upload_source_document` sends the file with `extractText: true` and `gantry serve` runs the same extractors (officeparser, with
Gantry's own Word-comment reader for a Reviewed copy), so a document uploaded here and in the browser gives the same text. The
response says whether any text was read and why not (a picture, a scanned PDF, an unreadable file). The document is kept either way.

**Access control is unchanged.** These are files in the same repository an agent could already read with the workspace's PAT;
no new credential, route or permission is involved. A Local workspace's files are on the architect's computer and are not reachable
from here, so none of these tools can reach one. ADR-0048 stays proposed.

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
