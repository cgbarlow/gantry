# A server workspace can be stored in an operator-declared Blob container

Ticket #212, map #238 (v0.13.0). Facts from #259 (`docs/research/blob-storage.md`
on `research/blob-storage`). Builds on ADR-0031 (server workspace directories)
and ADR-0068 (the Save check).

A container host's disk is wiped on redeploy, so today a server workspace
survives only on a persistent volume. On Render that volume ties Gantry to one
instance with no zero-downtime deploys.

**Still a server workspace, stored somewhere else.** The "+ New Workspace"
wizard's Server workspace option gains a **Store in** choice: the server's disk
or one of the operator's **Blob containers**. A blob-stored workspace is a
folder in the container with the same layout as on disk (`workspace.json` plus
Instance folders, Definitions, assets, `sources/`, `reviews/`, `interview/`),
and it behaves like any server workspace. It has no commits, PRs or work items.
The server's own folder, its registries, library settings, library cache and
the bundled Examples workspace stay where they are.

**The operator declares the containers.** `GANTRY_BLOB_CONTAINERS` lists each
container's name, URL and credential type: connection string, SAS, managed
identity or service principal. Any secret sits in a separate environment variable
that the declaration names. Gantry builds that one credential type, never
`DefaultAzureCredential`. This is a third server-held credential, alongside
library repos (ADR-0036) and shared workspaces (ADR-0047). No architect holds
it, because no architect's identity is involved: the container belongs to the
deployment. A malformed declaration stops startup with one line. A container
that can't be reached at runtime marks its workspaces unavailable with the
reason, and the rest of Gantry carries on.

**The container is the truth, and several servers may share it.** A
blob-stored workspace's id is derived from its container and folder. Its
Instances and their short numbers are kept in the container and read from it,
not from a server's own registry. A workspace made on one server shows on every
server, and a redeploy loses nothing. A zero-downtime deploy already means two
servers at once, so "one server at a time" would have saved little.

**Gantry reads and writes the container directly**, on the same async path
remote workspaces use to reach their repo. It keeps no local copy, because a
copy goes stale the moment another server writes. A Save is all-or-nothing:
it holds a short lease on the Instance for the duration, and every file write
is conditional on the ETag it read. ADR-0068's stage version is a fingerprint
of the stage's content, the same on disk and in blob. The saver supplies the
base for the three-way merge, as it does on disk.

**No history.** Like a server workspace on disk, a blob-stored one has no
commits, and renders cite what they cite today. Blob versioning and soft delete
are recommended to operators as a backup, but Gantry doesn't rely on them.
Azurite, the emulator CI runs against, has neither. Rendering copies the
files Pandoc needs to a scratch folder, and nothing is persisted.

The storage layer offers only what Azure Blob, S3 and GCS share: text and byte
reads and writes, listing by prefix, delete, writes conditional on what was
read, and a short lease. Only Azure Blob is built.

## Considered options

- **One setting that moves the whole data folder to blob.** Rejected. It
  would carry the registries and library cache too, but it makes storage
  all-or-nothing for the server and hides the bundled Examples, as a volume
  does today.
- **A third kind of workspace ("blob workspace").** Rejected. It behaves
  exactly like a server workspace, so a new name would be one more kind to
  explain.
- **Architect-entered container URL and SAS in the wizard.** Rejected. It
  rules out managed identity, and the server would have nowhere durable to
  remember it.
- **A local copy filled at startup and written through.** Rejected. Every
  read would still need a freshness check once two servers share the
  container, and startup slows as data grows.
- **Rediscovering blob workspaces only at boot.** Rejected. Workspaces made
  on one server would be missing on others, and short numbers could differ
  between servers.
- **Per-file conditional writes without a lease.** Rejected. A server dying
  mid-Save could leave a stage half-written.
- **Using blob versioning as history or provenance.** Rejected. A version has
  no author or message, it isn't available on Data Lake accounts, and it
  can't be tested on Azurite.

## Consequences

- The `gantry` CLI stays disk-only. Blob-stored workspaces are used through
  the web UI and MCP.
- There is no in-app move between disk and blob. Because the folder layout is
  identical, an operator copies the folder with Azure's tools and Gantry finds
  it.
- Tests start Azurite from npm inside the image's test stage, with
  `@azure/storage-blob` held at 12.32.x until Azurite accepts newer API
  versions.
