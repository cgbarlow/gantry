# A PAT belongs to a workspace, not to the user

`#104` generalised the browser's credential store from a single global PAT to a global default plus per-workspace overrides. That shape was correct while every workspace was Azure DevOps: a fallback could only ever be sent to the system it came from. With two providers it stops being correct — the global default is precisely the mechanism that sends an Azure DevOps PAT to GitHub and produces a 401 nobody can explain.

## Decision

The global-default credential tier is removed. Every workspace holds its own PAT; there is no fallback. `pat`, `setPat`, `clearPat`, `authHeader()` and the `DEFAULT_WORKSPACE_KEY` slot in `web/lib/credential.js` go with it.

A one-shot migration on first load copies any stored global PAT into the slot of every workspace currently registered, then deletes `gantry:ado-pat`. Existing per-workspace overrides are already in the right shape and are left alone. Nobody re-enters a credential.

The **browser-to-gantry** header is unchanged: HTTP Basic, empty username, PAT as password, decoded by `getCredential(req)` exactly as before. The credential stays an untagged string, because the server can always determine the provider from the workspace the route names. The one route that cannot — the wizard's repo check, which runs before any workspace exists — already carries the repo location in its request body, so `provider` simply joins it there. The wizard holds its PAT in memory and persists it to the new workspace's slot only once creation succeeds.

Only the **gantry-to-provider** header is provider-specific, and it is already encapsulated per client.

Library repos are unaffected by any of this. They authenticate with a server-side environment credential, not the browser's (`docs/adr/0036`, §Credential) — see `docs/adr/0039` for how that one provider-blind variable becomes provider-aware.

## Alternatives considered and rejected

- **Keeping the global default as a hidden fallback,** removed from Settings but still consulted. Rejected: it preserves the exact failure this change exists to eliminate, while making it harder to diagnose because the credential being sent is no longer visible anywhere in the UI.
- **A global default per provider.** Rejected: it keeps a global tier, and the cross-provider leak it prevents is already prevented by per-workspace PATs. It would mean a user's GitHub PAT is silently tried against every GitHub workspace they can see, including ones in orgs they were never meant to reach.
- **Tagging the credential at the header** so `getCredential(req)` returns `{provider, token}`. Rejected for now: it would make a provider mismatch a catchable 400 rather than a confusing upstream 401, which is genuinely better, but it touches every call site and every test that constructs an auth header to buy an error message we can produce from the registry anyway.

## Consequences

- A user working across several workspaces enters and rotates several PATs. This is the intended trade: a credential's blast radius is now one workspace.
- Any code path that needs provider access without naming a workspace must either name one or accept a location plus provider in its request. There is no ambient credential left to fall back on.
- A workspace whose PAT is missing or rejected prompts for that workspace specifically, and the submitted PAT lands in that workspace's slot — removing the `#104` subtlety where a prompt wrote to the global slot unless an override already existed.

Status: accepted. Decided during the first-class-GitHub-support grilling session, 2026-09-18, ahead of implementation.
