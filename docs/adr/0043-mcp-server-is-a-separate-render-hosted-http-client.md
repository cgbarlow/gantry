# The MCP server is a separate, Render-hosted HTTP client of gantry serve

Gantry needed an MCP (Model Context Protocol) server letting an AI agent do everything the web UI does — author definitions, create and progress workspaces/instances, request approvals — without duplicating gantry's own business logic or inventing a second credential model.

## Decision

Ship it as its own package, deployed as its own service on Render (alongside the existing `gantry serve` deployment there), speaking MCP over streamable HTTP. It holds no gantry internals: every capability is a thin call against `gantry serve`'s existing `/api/*` surface, using the identical per-request HTTP Basic PAT auth the browser already uses (`docs/adr/0038`). Two independent auth layers exist: a single shared static bearer token (env var) gates who may talk to the MCP server at all — single-tenant, no OAuth — while a JSON env var mapping workspace → PAT (read once at process start, never exposed to the model) supplies the Workspace PAT for calls touching a Provider-backed workspace. Server-hosted (non-Provider) workspaces need neither.

Scope for this first build: instance content (modules, render, stage advancement, approval/review, work-item linking), definitions authoring (whole-document get/update against the same validation the editor uses — no drag-and-drop-equivalent granular tools), and workspace creation/lifecycle (the "+ New Workspace" wizard's repo-check + create, archive/restore). Library-repo settings and identities are left to the web UI for now. Every tool is single-purpose and named for exactly one action, including irreversible ones (advance-stage, merge-via-check-status, archive) — there is no generic passthrough tool and no in-server confirmation gate; the calling client's own tool-review UX is the safety net. The MCP surface exposes tools only, no MCP resources.

## Considered Options

- **Embedding an MCP endpoint inside `lib/server.js` itself** (own transport, same process as the REST API). Rejected: a separate service avoids coupling the MCP release/runtime to gantry serve's, and lets the MCP layer point at any reachable gantry serve — local, Docker, or Render — without a code change.
- **A `gantry mcp` CLI subcommand** shipping inside the existing npm package. Rejected in favour of a fully separate package/binary, decoupling the MCP server's release cadence from gantry's own.
- **OAuth 2.1 for MCP-server access.** Rejected for now: this is a single-tenant server for one operator, so a static shared bearer token is sufficient and avoids building an auth flow with no second tenant to justify it.
- **Per-call PAT as a tool argument, or a persistent on-disk credential store the MCP server manages.** Rejected in favour of an env-var PAT map: keeps secrets out of the LLM's context and avoids introducing a new persistent secret store.

## Consequences

- True **Local workspaces** (data in a folder on the browser user's own machine, reached only via the File System Access API) are structurally unreachable from this server-hosted MCP client — there is no folder handle for it to hold. MCP scope is inherently limited to Server-hosted workspaces (remote-Provider-backed and server-directory).
- Adding a second MCP operator later means revisiting the shared-bearer-token model — most likely toward an OAuth shape — not a config tweak.
- The MCP package's release cadence is independent of gantry's; a gantry `/api/*` breaking change requires a coordinated bump of both, since there is no shared package boundary enforcing compatibility.

Status: accepted. Decided during the gantry-MCP-server grilling session, 2026-09-20, ahead of implementation.
