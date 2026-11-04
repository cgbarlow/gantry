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
  else). In an interview session the version is required (see "Running an AI interview session" below).

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
| `add_source_document_from_address` | Adds a document from a web address, as the browser's **Add from address** does (#318, `docs/adr/0071`): `gantry serve` fetches a snapshot (private, loopback and cloud-metadata addresses refused at every redirect, 25 MB, the upload types plus HTML), then it is added like an upload with its `origin` (`address`, `finalAddress`, `fetchedAt`). |
| `fetch_source_document_again` | **Fetch again** for a document with an `origin`: identical bytes add nothing (`unchanged: true`); changed ones are added as a new document that replaces the old one, which flags the Fields drawn on it Out of date. Only the newest copy is fetched again, as in the app: one that has already been replaced is refused. |
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

**Adding by address follows the operator.** The two address tools are listed only while `gantry serve` offers adding by address:
an operator who sets `GANTRY_SOURCE_FETCH_DISABLED` on `gantry serve` switches them off here as well as in the browser (the MCP
server asks `GET /api/sources/fetch`, at most every 30 seconds). Private addresses are allowed only by `gantry serve`'s own
`GANTRY_SOURCE_FETCH_ALLOW_PRIVATE_URLS`. Neither is set on the MCP server.

**Access control is unchanged.** These are files in the same repository an agent could already read with the workspace's PAT;
no new credential, route or permission is involved. A Local workspace's files are on the architect's computer and are not reachable
from here, so none of these tools can reach one. ADR-0048 stays proposed.

## Running an AI interview session

Following `docs/adr/0067`, an outside agent can run the whole AI interview itself. It asks its questions in its own chat (question
cards are web-only) and Gantry gives it what Gantry's own AI gets and holds it to the same rules. The rules live in `gantry serve`;
these tools are thin calls to it.

| Tool | What it does |
| --- | --- |
| `get_interview_brief` | The interview brief for a stage (`brief`, nine parts in precedence order: Gantry's rules, the pinned skills, Interview instructions, the stage, Fields in scope, saved content, preferred terms, Source documents, the decisions log so far), built by the same code as the in-app AI's, plus a `recap` of the stage's log, the `heldModules` of a drafted-ahead stage and the `stageVersion` to save against. Read-only. |
| `start_interview_session` | Starts a "run until stage X" session: returns the `session` to pass on (an id, `runUntil`, state), the brief and recap, `stageVersion` and `notes` (another session still going on the stage, held modules). Writes nothing. |
| `pause_interview_session` | Saves the entries, the session status (state `paused`) and, if `modules` are passed, the drafts so far, in one commit. |
| `resume_interview_session` | Resumes from the last commit, whichever side paused: runs Check status once first on a workspace whose stage has a Pull Request, then returns the brief and recap and takes over the paused session (`who` or `session` picks it). The committed log wins. |
| `update_instance_modules` | Takes `session`, `entries` and `stageVersion`. The stage-summary confirm is its one save: the content, the entries and the status in one commit. |
| `advance_stage`, `request_approval` | Take `session` so Gantry can hold the agent to the in-app AI's rules. |
| `get_review_response_list` | The Review response list as a Word document (`docxBase64`), built on demand from the stages' logs. |
| `record_review_answers` | Raises each Reviewed copy's "comments answered" count once the outcomes are saved. |

**A session moves between the browser and an agent through the last commit.** There is no session state on the server. A session is
recorded only by what the agent saves (its entries and a status line in the stage's `interview/<stage>.yaml`), so a session paused
in the browser resumes with `resume_interview_session` and one paused here resumes in the browser, which recaps from the same log.

**Saving.** Pass `session` (`id`, `runUntil`, `state`, `model`, `who`) and `entries` to `update_instance_modules` at the stage-summary
confirm. `stageVersion` is required in a session (a save without it is refused with `code: "stage_version_required"`; a stale one with
`stage_changed`, as outside a session). Entries have the shape the browser's log has (`answer`, `fact`, `open-question`, `term`,
`saved-content`, `source-update`, `review-answered`, ...). Gantry assigns each its `id`, time and session, stamps it
`recordedBy: "outside agent"` with the `agentModel` the agent reports, writes the session status (model named, tokens `"not
reported"`), and rebuilds the log's `fields` section from the content's `source:` citations and the entries that name each Field, so
Out of date detection works on a stage an agent drafted. Nothing is committed per answer.

**Guard rails.** In a session Gantry refuses, with `code: "session-guard"` or the existing code and the in-app AI's reason: passing a
gate (`advance_stage` is refused on a workspace with Pull Requests, and elsewhere until the session saved the stage with state
`saved`), `request_approval` for a stage the session has not saved, approvals out of stage order (refused for everyone,
`docs/adr/0063`) and writes to a module an earlier stage with an open Pull Request also mounts (`shared-module-pending`, also for
everyone). A call that names no session is treated like a person in the web UI: nothing new is refused.

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
