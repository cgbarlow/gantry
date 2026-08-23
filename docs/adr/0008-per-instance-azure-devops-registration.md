# Each instance's Azure DevOps location is chosen per-instance, through the web UI, via a shared server-side registry

ADR-0005 said the Azure DevOps repo backing an instance would be "specified during instance
setup" — one central gantry deployment, many instances, each independently backed by local
storage or its own Azure DevOps org/project/repo. #85–#87 instead built a narrower model with no
ADR of its own: `createServer(options.azureDevOps)` takes exactly one location, fixed for the
whole server process at startup. A follow-up PR then exposed that narrower model directly as CLI
flags (`--azure-devops-org`/`--azure-devops-project`/`--azure-devops-repo`) — rejected before merge
("I should not have to enter any of this via CLI, it should be in the interface"). This ADR
resolves the gap properly, per ADR-0005's original intent.

Gantry gains a shared, server-side **instance registry**: a single file (sibling to
`instancesDir`/`definitionsDir`, not committed to git — live application state, not source) mapping
every known slug to where its data actually lives, either `{ kind: 'local' }` or `{ kind:
'azureDevOps', organization, project, repository, baseUrl? }`. This is the *only* source of truth
gantry consults to route a request for a given slug — nothing is re-derived from any other source.
It exists precisely to solve the chicken-and-egg problem an Azure-DevOps-backed instance otherwise
has: gantry must know *where* to fetch `instance.yaml` from before it can read anything
`instance.yaml` itself might say. `createInstance`'s Azure DevOps path already writes an
`azureDevOps: {...}` field into the `instance.yaml` it creates — that field stays purely
descriptive; it is never read back for routing, and the registry is never reconciled against it.
If the registry file is ever lost, that is a separate, later problem, not one this design solves.

Both local and Azure-DevOps-backed instances are unified into this one registry — a local instance
is just as much a registry entry as a remote one, and the dashboard (`GET /api/instances`) reads
one list, not two merged sources. This does not, however, remove directory-scanning of
`instancesDir`: it becomes an **auto-backfill fallback**, not a competing source of truth. Any
`instance.yaml` found on disk with no existing registry entry gets one added automatically. This is
what keeps every pre-existing local instance (the `examples`/`demo-cli`/`demo-web` fixtures),
anything made via `gantry new` on the CLI, and every test's ad hoc temp instance working with zero
migration step — none of them predate the registry in a way that makes them invisible.

The setup wizard's existing (until now stubbed) "Azure DevOps repo URL" field and "Check repo"
button become real: submitting a URL makes an actual, PAT-gated call to Azure DevOps, proxied
server-side (the REST API has no CORS support for a browser-direct call — established in
ADR-0007), reusing the credential-prompt-and-retry-once flow `apiFetch.js` already built for #87
rather than inventing a second PAT UI just for the wizard. The field stays a single URL, parsed
assuming the standard `https://dev.azure.com/{organization}/{project}/_git/{repository}` shape;
a non-standard or on-prem Azure DevOps Server base URL is an explicit, known gap for now — still
reachable at the `lib/server.js` options level (tests, CI), just not from the wizard UI yet.

One Azure DevOps organization is assumed for everything a single gantry deployment serves — a
single shared PAT, resent per request, exactly as today. But PAT storage in `web/lib/credential.js`
is keyed by organization from the start (even though only one key is ever populated right now), so
a second organization can be added later without restructuring — the same "active default, seam
reserved for later" shape ADR-0007 already used for the Entra ID swap.

Alternatives considered and rejected:

- **Keep the one-repo-per-process CLI model** (the status quo this ADR replaces). Requires a
  server restart per instance and can't be driven from the browser at all — the exact complaint
  that triggered this ADR.
- **Remove directory-scanning entirely once the registry is unified.** Would make any instance not
  yet given an explicit registry entry — every existing fixture, everything `gantry new` or a test
  helper creates — silently invisible until something remembers to register it. Rejected: no
  compensating benefit for a real breaking change.
- **Treat `instance.yaml`'s own `azureDevOps` field as authoritative, or as a reconciliation
  fallback for a damaged registry.** Rejected as unnecessary complexity — a lost registry file is a
  separate, later problem; solving it now was not asked for.
- **Build a per-organization PAT-selection UI now.** Rejected: no second organization exists yet to
  test against — only the storage primitive (keyed lookup) is built now, mirroring why ADR-0007's
  Entra ID seam has no MSAL.js code yet either.

Status: accepted. The CLI-flags PR this ADR supersedes is abandoned, not merged.
