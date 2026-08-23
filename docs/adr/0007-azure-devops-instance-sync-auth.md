# Azure DevOps instance-data sync uses the REST API, gated by each user's own ADO permissions

ADR-0005 moved instance data into an external Azure DevOps repo per team but explicitly
deferred "the actual sync/auth mechanism (git clone vs. Azure DevOps REST API, credential/
service-connection model)." This resolves that.

Gantry stays a centrally-hosted, multi-user web server (not a per-architect local CLI) with
no gantry-specific login screen. Its backend calls the Azure DevOps REST API directly —
never `git clone`/`push` — because Azure DevOps's REST API doesn't support cross-origin
browser calls, so every instance-data request is proxied server-side anyway, and a stateless
REST call per request is simpler for a shared multi-user server than managing per-instance
working copies. Every instance-data read or write is gated by the *requesting user's own*
Azure DevOps permissions — there is no shared service identity — because that per-team access
control via each team's existing ADO permissions is the entire reason ADR-0005 moved instance
data into ADO in the first place.

Credential mechanism: each user pastes their own Azure DevOps PAT into gantry once (scoped to
Code + Work Items — gantry's ADO client is intentionally general-purpose, since Boards/work-item
tracking of delivery work on instances is planned), held client-side only (browser storage) and
resent on every request; gantry's backend never persists it. **This is the active, permanent
mechanism for the foreseeable future — not a short-lived stopgap.**

Credential acquisition sits behind a credential-provider seam (something like `getCredential()`)
precisely so a second implementation can slot in later without touching the ADO client or proxy
code: silent Microsoft Entra ID SSO via MSAL.js (a public-client SPA registered in Entra ID),
falling back to one interactive popup only when no AAD session exists — reusing whatever Azure
DevOps session the user's browser already has, with no separate gantry login. For now, only the
seam itself and the PAT-backed implementation exist; no MSAL.js code gets written until an Entra
ID app registration actually exists for gantry to test against — there's nothing to build safely
without it. The two are not "temporary vs. permanent"; they're "active default" vs. "seam reserved
for later."

The CLI (`gantry status`/`check`/`render`/`new`) keeps working exactly as today, but only
against local/example/demo instances and CI (`azure-pipelines.yml`) — it does not grow a
second, separate auth path (e.g. device-code flow) to reach real ADO-backed instances. Real
instance work happens only through the hosted web server.

Alternatives considered and rejected:

- **Local CLI/server per architect, with MSAL Node's interactive loopback-browser flow.**
  This was the initial framing, but doesn't fit once gantry is confirmed as a centrally-hosted
  multi-user server rather than a tool each architect runs on their own machine.
- **`git clone`/`push` per operation**, authenticating via a token embedded in the HTTPS
  remote URL. Works, but a shared server managing per-instance working copies and concurrent
  checkouts is operationally messier than stateless REST calls, for no real benefit once the
  REST API has to be reached from the server anyway.
- **A single shared PAT (or other service identity) owned by gantry itself.** Far simpler to
  set up, but collapses per-team access control entirely — every user would get the PAT
  holder's access to every team's instance data, regardless of their own real ADO permissions.
  Rejected because that's the exact problem ADR-0005 relied on ADO's own permission model to solve.
- **Browser calls the Azure DevOps REST API directly**, with no gantry backend involved.
  Rejected: confirmed Azure DevOps's REST API does not support CORS for arbitrary SPA origins,
  so this doesn't work regardless of how appealing the simpler shape would be.
- **Server-side token/PAT cache keyed to a session cookie.** Rejected in favour of a fully
  stateless backend — no secret store or session infrastructure to build or secure.

Status: accepted, first-cut. PAT entry is the mechanism actually in use, with no default
expectation of when or whether it's superseded. A credential-provider seam is built so an
MSAL.js/Entra ID implementation can be added later without touching the ADO client or proxy
code — but no MSAL.js code exists yet; there's nothing to build against until an Entra ID app
registration exists for gantry, which is a separate future decision, not implied by this one.
