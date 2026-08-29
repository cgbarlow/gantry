# Azure DevOps credentials in the agent container

How git and the `azure-devops` MCP tools authenticate to Azure DevOps
(org `Contoso-Production`, project `Default`, repo `gantry`) from inside the
devpod / devcontainer that agent sessions run in.

## TL;DR

- Auth is done with a **Personal Access Token (PAT)**, not your local
  machine's Entra / GCM sign-in.
- The PAT is served to git by a repo-scoped credential helper,
  `~/.rfa-cred-helper.sh`, and the `azure-devops` MCP server carries its
  own copy.
- The DevPod "forward my laptop's git credentials" path still exists in
  config but is **unreliable and not what you should depend on** — the
  forwarded Entra token is rejected by Conditional Access from inside the
  container.
- If ADO auth breaks, it's almost always the **PAT** (expired / rotated)
  or a **Conditional Access** policy change — not something you fix by
  re-forwarding laptop credentials.

## Why it's a PAT and not laptop SSO

Historically the container relied on DevPod forwarding the host machine's
Git Credential Manager (GCM) session — you signed in once on your laptop
with your `@contoso.com` identity and the container borrowed that token.

That stopped working: an Entra **Conditional Access** policy on
`Contoso-Production` now refuses a token presented from the container's
context (unmanaged / headless device). A git request that reaches ADO
with only the forwarded token gets:

```
HTTP 401
www-authenticate: Bearer authorization_uri=https://login.microsoftonline.com/<tenant-id>
x-tfs-serviceerror: TF400813: The user 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' is not authorized
x-tfs-fedauthredirect: https://vssps.visualstudio.com/_signin?...protocol=entra.web.2
```

(the all-zero user GUID + a redirect to interactive sign-in = the token
was treated as anonymous).

The workaround — provisioned by the ready-for-agent (RFA) harness /
`keymaxxer` — is a **PAT** installed on both the host and the container.
PAT basic-auth bypasses Conditional Access, so `git` and the MCP server
work. See the `ado-pat-workaround` skill for the recovery procedure when
`git push` or pipeline-log fetches 401.

## The git credential-helper chain

`git` builds its helper list from three config files, in this order:

| Source | Helper | Notes |
| --- | --- | --- |
| `/etc/gitconfig` | vscode-remote-containers helper | devcontainer default |
| `/etc/gitconfig` | `devpod agent git-credentials --port 16545` | **stale** — always `connection refused`, git skips it |
| `~/.gitconfig` | `devpod agent git-credentials --port 12049` | forwards to the host DevPod process |
| `~/.gitconfig` | `~/.rfa-cred-helper.sh` *(scoped to `https://dev.azure.com`)* | **this is the one that reliably works** |

Also in `~/.gitconfig`:

- `credential.https://dev.azure.com.usehttppath=true` — git sends the
  full repo path to the helper. The forwarded (`12049`) helper only
  resolves a credential when the path is exactly
  `Contoso-Production/Default/_git/gantry`; any other path makes the
  host-side `git credential fill` exit 128.
- `credential.azrepos:org/Contoso-Production.azureauthority=https://login.microsoftonline.com/<tenant-id>`
  — leftover from the Entra-token era.

`~/.rfa-cred-helper.sh` is a ~3-line script: for any input containing
`host=dev.azure.com` it echoes `username=<user>@contoso.com` and
`password=<PAT>`. It is unconditional and last in the chain, so it's the
effective fallback whenever the DevPod-forwarded helpers return nothing.

### Known noise

Every git command in the container prints:

```
Error retrieving credentials: Post "http://localhost:16545/git-credentials": dial tcp [::1]:16545: connect: connection refused
```

That's the stale port-16545 entry in `/etc/gitconfig`. Git ignores it and
falls through to the next helper. Harmless; safe to strip the line if the
noise is a problem.

## MCP server auth

The `azure-devops` MCP server (`mcp__azure-devops__*`) authenticates with
its own PAT, independent of the git helper chain. If git works but MCP
calls 401 (or vice-versa), the two PATs have diverged — rotate/re-sync
both.

Always pass `project: "Default"` explicitly on every MCP call that takes a
`project` param (see `CLAUDE.md`).

## Checking it works

```bash
# read path
git fetch --no-tags origin

# write-auth path, makes no change
git push --dry-run origin HEAD:refs/heads/<your-branch>

# PAT directly (no helpers) — expect HTTP 200
curl -sS -o /dev/null -w '%{http_code}\n' -u ":$PAT" \
  'https://dev.azure.com/Contoso-Production/Default/_apis/git/repositories/gantry?api-version=7.1-preview.1'
```

MCP smoke test: `mcp__azure-devops__core_list_projects` with
`projectNameFilter: "Default"`, or `mcp__azure-devops__repo_search_commits`
scoped to `repository: ["gantry"]`, `project: "Default"`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `git` 401, `TF400813`, `_signin` redirect | PAT expired/rotated, or it fell through to the forwarded Entra token | Re-provision the PAT via the `ado-pat-workaround` skill / RFA harness |
| `git` prompts for username then `terminal prompts disabled` | No helper returned a credential (forwarded helper flaked, PAT helper missing) | Confirm `~/.rfa-cred-helper.sh` exists and is executable; re-run |
| MCP calls 401 but `git` works | MCP server's PAT is stale | Rotate/re-sync the MCP PAT |
| `connection refused` on `localhost:16545` | Stale `/etc/gitconfig` helper entry | Cosmetic — ignore, or remove the line |
| Works intermittently | The port-12049 forwarded helper is path-scoped and flaky; only the PAT helper is dependable | Rely on the PAT path; don't troubleshoot the forwarder |

## Security notes

- `~/.rfa-cred-helper.sh` stores the PAT in **plaintext**. Treat the
  container filesystem accordingly; don't echo the file into logs,
  transcripts, or issues.
- The PAT authenticates as a real user (`Chris.Barlow003@contoso.com`).
  Anything it does in ADO is attributed to that identity.
- If the PAT value is ever exposed (pasted into a transcript, a PR, a
  screenshot), rotate it in Azure DevOps and re-provision.
</content>
</invoke>
