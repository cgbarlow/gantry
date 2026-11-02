# Azure Blob Storage for server workspaces: what Blob offers, and how much of Gantry bypasses the storage seam

Research for #259, serving #212 (map #238). Checked 2026-11-02.

Repo facts cite `main` at `65924c7` (v0.12.1) as `file:line`. ADR-0064, ADR-0066 and ADR-0068 are not on `main` yet. They are cited from branch `docs/246-ai-drafting`. Azure facts link to primary sources (learn.microsoft.com, the Azure SDK for JS, the Azurite repo, render.com docs), and each doc's date is given where the page shows one. This note reports facts and trade-offs. The decisions belong to #212.

## Summary

- **The seam covers less than #212 assumes, and the gaps are in different places.**
  - **Through the seam:** the registries, `workspace.json`, workspace discovery, `instance.yaml` and module text.
  - **Around it:** assets and their manifest, the Instance logo, stage status's module reads, every server workspace Definition (with its templates and reference documents), the library cache's writes, the CLI's `out/`, and the workspace migration's directory rename.
  - **Binary files:** the seam has no methods for them at all.
- **The web UI's render already never writes `out/` for a server workspace.** The `.docx` goes straight to the browser (`lib/server.js:6103-6115`). Pandoc only needs local *inputs*. Gantry already copies remote files to local disk before rendering for every Provider.
- **The core of an async seam is already half-built.** The Provider code paths made `readInstance`, `readModule` and the writes return Promises. 87 of the 101 `readInstance` call sites outside `lib/instance.js` already `await` it. What is still synchronous throughout: the registries, Definitions, stage status, check, stage advancement, `resolveLocalDataDir`, and the CLI.
- **Blob has what optimistic saves need, per blob.** A write with `If-Match` fails with 412 if the blob changed. A 25 MB file goes up in one Put Blob. There is **no transaction across blobs**, so a multi-module Save can't be made all-or-nothing by ETags alone.
- **Azurite covers the core.** ETags, conditional headers, leases, prefix listing and Blob Batch all work. It does **not** support blob versioning or soft delete, so anything that relies on those can only be tested against a real account.
- **Credentials depend on the host.** App Service and Container Apps have managed identity. Render has none, so it needs a service-principal secret, a connection string or a SAS in an environment variable.
- **Gantry's Node floor is 24** (`package.json:19-21`). The current `@azure/storage-blob`, `@azure/identity` and `azurite` releases need Node 22 or later, so there is no conflict.

---

## 1. Seam coverage

`lib/storage.js:8-27` is the seam. It has six methods: `exists`, `readText`, `stat` (which returns a Node `fs.Stats`), `writeText`, `ensureDir` and `listDir`. It is **synchronous**, it handles **text only**, and it has **no delete or rename**. `localFilesystemStorage` is its only implementation, and every caller imports it by that name (for example `lib/instance.js:5`). There is no injection point yet.

### Already through the seam (the #212 description says some of these bypass it, but they don't)

| What | Where | Sync? |
|---|---|---|
| `workspace-registry.json` | `lib/workspaceRegistry.js:53-60` | sync |
| `instance-registry.json` | `lib/instanceRegistry.js:114-121` | sync |
| `discovered-empty-workspaces.json` | `lib/instanceRegistry.js:49-66` | sync |
| `number-registry.json` | `lib/numberRegistry.js:35-45` | sync |
| `library-repos.json` (library settings) | `lib/librarySettings.js:59-66` | sync |
| Library cache `meta.json` read | `lib/libraryCache.js:108-109` | sync |
| `workspace.json` write, server workspace discovery | `lib/workspaceDirectory.js:65`, `:84-88` | sync |
| Instance discovery under each workspace | `lib/instanceRegistry.js:327-337` → `lib/instance.js:962-963` | sync |
| `instance.yaml` create, read and update | `lib/instance.js:637-655`, `:989`, `:1099`, `:1171`, `:1231`, `:1291`, `:1331`, `:1419`, `:1839` | sync |
| Module files: write, multi-module write, read | `lib/instance.js:2182`, `:2267`, `:2315` | sync |
| Default-workspace check, legacy check | `lib/instanceDataDir.js:118`, `:146`; `lib/workspaceMigration.js:48` | sync |
| "Last updated" on the dashboard (mtime) | `lib/registry.js:29-39` | sync, uses `stat().mtimeMs` |

Three facts that matter for a blob backend:
- All the registries are read fresh on every call and never cached in memory, "so concurrent callers always see the latest persisted state" (`lib/numberRegistry.js:19`). That holds only while every process shares one store.
- Each registry update is a read-modify-write with no lock: read the file, change it, write it back (for example `lib/instanceRegistry.js:621-641`).
- `readModule` can **write on read**. An old-scale module file is migrated and written back (`lib/instance.js:2324-2328`).

### Bypasses the seam (direct `node:fs`)

| What | Where | Sync? | Notes |
|---|---|---|---|
| **Assets**: manifest read and write, upload | `lib/assets.js:18-26`, `:171-176` | sync | binary |
| Assets: "is this module used" check | `lib/assets.js:42` | sync | |
| Asset file served to the browser | `lib/server.js:6764-6770` | sync | `readFileSync` of a path from `getAsset` |
| Asset path handed to Pandoc | `lib/assets.js:106-113`, `:126-131` | sync | rewrites to an **absolute local path** |
| **Instance logo** (set on create, change) | `lib/instance.js:647-649`, `:1227-1232` | sync | binary write, `rmSync` of the old file |
| Instance logo read for render and API | `lib/instance.js:1270`; `lib/instanceLogo.js:79-83` | sync | |
| **Stage status reads module files** | `lib/status.js:196-200` | sync | runs after every module Save (`lib/server.js:5883`) |
| Module and example existence checks in routes | `lib/server.js:5171`, `:5282`, `:5367`, `:5428`, `:5438` | sync | |
| **Server workspace Definitions** (`<workspace>/definitions/`) | resolved at `lib/server.js:705-710` and `lib/definitionHome.js:33-35` | sync | inside the workspaces root |
| Definitions: load, list, versions | `lib/definition.js:291-314`, `:369-420`, `:1072-1085` | sync | |
| Definitions: draft, write, publish, clone, archive | `lib/definition.js:1038-1060`, `:1350-1367`, `:1403-1432` (temp copy + `renameSync`), `:1440-1543`; `lib/definitionHome.js:231-243` | sync | `cpSync` and `renameSync` of whole folders |
| Definition templates, reference `.docx`, logo | `lib/definition.js:24-178` | sync | binary |
| Promotion records | `lib/definitionPromote.js:55-73` | sync | |
| **Library cache** (refresh rewrites the whole tree) | `lib/libraryCache.js:208-223` | sync | `rmSync` recursive, then rewrite. Rebuildable from the library repo, but it is what keeps a pinned Definition working while that repo is down (`lib/server.js:700-704`) |
| **Render output `out/`** (CLI, and the native render's `.md`) | `lib/render.js:1177-1178`, `:1197`, `:1226` | sync | not written by the web UI for server workspaces (see part 5) |
| Render manifest `out/.render-manifest` | `lib/render.js:82-101`, `:1334` | sync | |
| **Workspace migration** (legacy root → `default`) | `lib/workspaceMigration.js:56` | sync | `renameSync` of whole instance folders |
| Instance creation order for number backfill | `lib/numberRegistry.js:217-224` | sync | `statSync().birthtimeMs` |
| Header-logo cache keyed by mtime | `lib/instanceLogo.js:25-37` | sync | in-memory, per process |

Out of scope, but they use the same kind of local disk: the bundled `definitions/` folder in the image, static web files (`lib/server.js:426-443`), and a browser local workspace's server-side compile. That last one builds its tree in a temp folder and deletes it afterwards (`lib/localWorkspace.js:328-401`).

### The v0.13.0 additions (planned; no code yet)

None of these exist on `main`. `grep` finds no `sources/`, `reviews/` or `interview/` in `lib/`. Whoever builds them decides whether they go through the seam.

| What | Planned shape | Notes |
|---|---|---|
| `interview/<stageId>.yaml` | one YAML file per stage, append-only entries (ADR-0064:15-30, on `docs/246-ai-drafting`) | text. Logs from two sessions are *merged*, not overwritten (ADR-0068) |
| `reviews/` + `reviews/manifest.yaml` | Reviewed copies, 25 MB cap (ADR-0066:50-51, on `docs/246-ai-drafting`) | binary `.docx` |
| `sources/` | Source documents, 25 MB per document recommended (`docs/research/source-document-size-limits.md:83`, on `research/source-document-size-limits`) | binary. Layout not yet in an ADR |

Two of the three are binary, so is every asset and logo. A seam that has to carry them needs byte methods (read, write), plus delete. It probably needs a listing that can tell files from folders too.

---

## 2. Azure Blob features

### ETags and conditional writes
- Every write updates the object's ETag. Optimistic concurrency means reading the ETag, then writing with `If-Match`. A changed ETag gives **HTTP 412**. [Managing concurrency in Blob Storage](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage) (2025-03-25).
- `If-None-Match: *` means "only if the blob doesn't exist", which gives a create-only write. Put Blob, Put Block List, Set Blob Metadata and Properties, and Delete Blob accept `If-Match` and `If-None-Match`. **Put Block and List Blobs don't.** [Conditional headers](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations) (2026-01-20).
- Error codes: `ConditionNotMet` is 412 on a write. `BlobAlreadyExists` is 409. [Common error codes](https://learn.microsoft.com/en-us/rest/api/storageservices/common-rest-api-error-codes), [Blob error codes](https://learn.microsoft.com/en-us/rest/api/storageservices/blob-service-error-codes).
  - **Not settled:** Microsoft's table says a failed `If-None-Match: *` write is 412. Azurite returns 409 `BlobAlreadyExists` ([WriteConditionalHeadersValidator.ts](https://github.com/Azure/Azurite/blob/main/src/blob/conditions/WriteConditionalHeadersValidator.ts), [ChangeLog](https://github.com/Azure/Azurite/blob/main/ChangeLog.md)). Treat both as "already exists" until checked against a real account.
- A metadata write counts as a write. It returns a new ETag and changes Last-Modified ([Set Blob Metadata](https://learn.microsoft.com/en-us/rest/api/storageservices/set-blob-metadata)). **Set Blob Tags does not change the ETag** ([Set Blob Tags](https://learn.microsoft.com/en-us/rest/api/storageservices/set-blob-tags), 2026-03-26). Put Blob replaces all metadata.
- JS SDK: `conditions: { ifMatch, ifNoneMatch, ... }` on `upload` and `uploadData` ([BlobRequestConditions](https://learn.microsoft.com/en-us/javascript/api/@azure/storage-blob/blobrequestconditions), [BlockBlobParallelUploadOptions](https://learn.microsoft.com/en-us/javascript/api/@azure/storage-blob/blockblobparalleluploadoptions)).
- **Checking for a change costs one request.** Get Blob Properties is a single HEAD that returns the ETag ([Get Blob Properties](https://learn.microsoft.com/en-us/rest/api/storageservices/get-blob-properties), 2026-10-29). A Get Blob with `If-None-Match: <etag>` returns 304 if nothing changed, so "fetch only if changed" is one request too.
- **Leases** are the pessimistic alternative. They last 15–60 s or are infinite. A write without the lease ID fails with 412 ([concurrency doc](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage)).
- **No multi-blob transaction.** Blob Batch supports only Delete Blob and Set Blob Tier, up to 256 subrequests. It "isn't atomic", and the order of execution isn't guaranteed ([Blob Batch](https://learn.microsoft.com/en-us/rest/api/storageservices/blob-batch), 2023-11-28). There is no rename operation ([Blob REST API](https://learn.microsoft.com/en-us/rest/api/storageservices/blob-service-rest-api)).

### Blob versioning
From [Blob versioning](https://learn.microsoft.com/en-us/azure/storage/blobs/versioning-overview) (2026-10-02):
- It is an **account-level** setting.
- Every write, metadata writes included, creates a new immutable version. Each version has a timestamp ID in `x-ms-version-id`.
- **Not supported on hierarchical-namespace (Data Lake Gen2) accounts.**
- Microsoft recommends **fewer than 1,000 versions per blob**.
- Versions are billed like live data. Because Put Blob replaces every block, each overwrite effectively bills the whole object again.
- Lifecycle management can prune previous versions. Policies are free, and a new or changed policy can take up to 24 h to start ([Lifecycle management](https://learn.microsoft.com/en-us/azure/storage/blobs/lifecycle-management-overview)).
- Deleting a previous version needs **Storage Blob Data Owner**.

A version records *what* changed and *when*. It records no author or message, so it isn't a commit. Gantry's render cites a commit as provenance. For comparison, a server workspace render today names the server's own `git` HEAD (`lib/render.js:1326`), not a commit of the data.

### Soft delete
- **Blob soft delete** keeps deleted data for 1–365 days ([Soft delete for blobs](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-blob-overview), 2026-10-02).
  - Without versioning, an overwrite is kept as a soft-deleted snapshot, but metadata writes aren't protected.
  - With versioning, overwrites become versions instead.
  - Undelete restores *all* soft-deleted versions and never promotes one to current.
- **Container soft delete** keeps a deleted container for 1–365 days (default 7). It restores only whole, to the original name ([Container soft delete](https://learn.microsoft.com/en-us/azure/storage/blobs/soft-delete-container-overview)).

### Listing by prefix
- `listBlobsFlat` and `listBlobsByHierarchy("/", { prefix })` return up to 5,000 results per page ([List blobs with JS](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-list-javascript), [List Blobs REST](https://learn.microsoft.com/en-us/rest/api/storageservices/list-blobs)).
  - A page can come back short and still carry a continuation marker.
  - Results are alphabetical, upper-case first.
- On a flat namespace, folders are **virtual**: they exist only as part of blob names. An empty folder can't exist. `ensureDir` has nothing to create, and a folder whose only file is `workspace.json` exists only because that file does.
- **Rename** is copy then delete, and it isn't atomic. A hierarchical namespace makes renames atomic, but it can't be switched off once enabled and it rules out versioning ([Data Lake namespace](https://learn.microsoft.com/en-us/azure/storage/blobs/data-lake-storage-namespace)).

### Size limits vs the 25 MB cap
From [Put Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob) and [Scalability targets](https://learn.microsoft.com/en-us/azure/storage/blobs/scalability-targets) (2026-07-24):

| API version | Max block | Max block blob (50,000 blocks) | Max single Put Blob |
|---|---|---|---|
| 2019-12-12 and later | 4,000 MiB | ~190.7 TiB | 5,000 MiB |
| 2016-05-31 – 2019-07-07 | 100 MiB | ~4.75 TiB | 256 MiB |

- The SDK's single-request threshold (`maxSingleShotSize`) is **256 MB** by default.
- **A 25 MB Source document or Reviewed copy goes up in one Put Blob.** That is one atomic write, so `If-Match` and `If-None-Match` cover the whole file.

### Cost and latency of small reads
East US, LRS, USD, from the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices) ("General Block Blob v2" and "Premium Block Blob"), 2026-11-02. Prices vary by region. The [public pricing page](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/) shows the same products.

| | Hot | Cool | Premium |
|---|---|---|---|
| Storage per GB-month | $0.0208 | $0.0152 | $0.15 |
| Writes per 10,000 | $0.05 | $0.10 | $0.0175 |
| Reads per 10,000 | $0.004 | $0.01 | $0.0014 |
| List per 10,000 | $0.05 | — | $0.05 |
| Other (including HEAD) per 10,000 | $0.004 | — | $0.0014 |

- At Hot prices, a million small reads cost about $0.40 and a million writes about $5.
- Cool has a 30-day minimum and charges early deletion, Put Blob overwrites included ([Access tiers](https://learn.microsoft.com/en-us/azure/storage/blobs/access-tiers-overview)). That makes Cool a poor fit for files that are rewritten on every Save.
- **No latency SLA is published.** The SLA covers availability. Time to first byte is given only as "milliseconds" for Hot and Cool. Premium (SSD) is described as giving "fast and consistent response times", with no figure ([Premium block blob](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-block-blob-premium)).
- Scale targets: 3,000 requests per second per blob, and 40,000 per second per GPv2 account in major regions. Throttling returns 503 or 500 ([Scalability targets](https://learn.microsoft.com/en-us/azure/storage/blobs/scalability-targets), [Standard account targets](https://learn.microsoft.com/en-us/azure/storage/common/scalability-targets-standard-account)).
- What this means for Gantry today: one `GET /api/instance` does many small synchronous disk reads (instance, modules, registries, Definition). Over the network, each becomes a round trip unless it is cached locally.

---

## 3. Credentials

How each credential type connects, from [Get started with Blob Storage and JavaScript](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-javascript-get-started) (2025-10-08):

| Credential | How | Notes |
|---|---|---|
| Connection string or account key | `BlobServiceClient.fromConnectionString(cs)`, or `new StorageSharedKeyCredential(name, key)` | "effectively has access to all the data" |
| SAS | `new BlobServiceClient(\`${url}?${sas}\`)` | Microsoft prefers a **user delegation SAS**. Account and service SAS stop working if shared key is disabled |
| Entra ID | `new BlobServiceClient(url, new DefaultAzureCredential())` from `@azure/identity` | needs the **Storage Blob Data Contributor** role (Data Owner to delete versions or set tags) |

- An account can set `AllowSharedKeyAccess=false`. Key requests, and account or service SAS, then get 403, but a user delegation SAS still works ([Prevent Shared Key authorization](https://learn.microsoft.com/en-us/azure/storage/common/shared-key-authorization-prevent), 2026-08-11).
- **`DefaultAzureCredential` chain (JS):** Environment → Workload Identity → Managed Identity → VS Code → Azure CLI → Azure PowerShell → Azure Developer CLI → Broker.
  - `AZURE_TOKEN_CREDENTIALS` can narrow it to `prod`, `dev` or a single credential (needs `@azure/identity` 4.11.0 or later).
  - Microsoft's guidance for deployed apps is to **replace `DefaultAzureCredential` with a specific credential**, such as `ManagedIdentityCredential` ([Credential chains](https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/credential-chains), 2026-06-01).
  - A service principal uses `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_CLIENT_SECRET` (or a certificate path) ([identity README](https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/identity/identity/README.md)).
- **Package versions:** `@azure/storage-blob` 12.34.0 and `@azure/identity` 4.14.x need Node 22 or later (npm registry metadata). Gantry requires Node 24 or later (`package.json:19-21`), so this is fine.

### By host

| Host | Managed identity | Credential Gantry would use | File-share alternative |
|---|---|---|---|
| **Azure App Service** | yes, system- and user-assigned ([doc](https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity), 2026-04-14). Role changes can take ~24 h | `ManagedIdentityCredential` | Azure Files mount, shared by all scaled-out instances. Microsoft advises against mounts for apps "that rely on file handles and locks". Blob mounts are read-only ([doc](https://learn.microsoft.com/en-us/azure/app-service/configure-connect-to-azure-storage)) |
| **Azure Container Apps** | yes. A user-assigned identity needs its client ID passed explicitly ([doc](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity)) | `ManagedIdentityCredential` | Azure Files (SMB/NFS) shared across replicas. Blob can't be mounted ([doc](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts), 2026-10-13) |
| **Render** | **no** (inferred: Render's docs mention none; Microsoft's guidance for apps hosted outside Azure is a service principal) | service-principal secret, connection string or SAS, as environment variables. Secret files are limited to 1 MB combined ([Render env vars](https://render.com/docs/configure-environment-variables)) | Render persistent disk: paid services only, **single instance only, no zero-downtime deploys**, daily snapshots kept 7 days ([Render disks](https://render.com/docs/disks)) |

The Render disk's single-instance rule is the "pay for a disk and keep it on one instance" problem #212 describes.

---

## 4. Azurite

**Running it** ([Azurite README](https://github.com/Azure/Azurite/blob/main/README.md), v3.37.0):
- Docker image `mcr.microsoft.com/azure-storage/azurite`, blob on port 10000. Or the npm package: `npx azurite-blob`.
- Useful flags: `--inMemoryPersistence`, `--loose`, and `--skipApiVersionCheck` (or `AZURITE_SKIP_API_VERSION_CHECK=true`).
- Account `devstoreaccount1` with a published well-known key. The explicit connection string to `http://127.0.0.1:10000/devstoreaccount1` is the safe form. It is unconfirmed whether the JS SDK accepts the short form `UseDevelopmentStorage=true`.
- **API version gap.** `@azure/storage-blob` 12.34.0 sends service version `2026-10-06`. Azurite 3.37.0 accepts up to `2026-06-06` and rejects newer versions with 400. So either pin the SDK at 12.32.x or run Azurite with the version check skipped.
- The image has **no HEALTHCHECK**, so tests must poll until Azurite is ready.

**In Gantry's CI**
- CI is **Azure Pipelines**, not GitHub Actions. The unit tests run **inside `docker build`**, in the `test` stage of `ContainerFile` (`azure-pipelines.yml:34-39`; `ContainerFile:61-72`).
- **Service container.** Azure Pipelines can run one beside the job (`resources: containers:` plus `services:`, with `ports: 10000:10000` for a job on the agent) ([Service containers](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/service-containers), 2025-09-12).
  - The image runs with its default command, so the version-check skip has to go in through `env:`.
  - *Inference, not tested:* a `RUN` step inside `docker build` doesn't reach the agent's `localhost` by default. A service container would need extra build networking, or the tests would have to move out of the image build.
- **npm route.** Starting Azurite in the background from npm is Microsoft's own pipeline sample ([Use Azurite to run automated tests](https://learn.microsoft.com/en-us/azure/storage/blobs/use-azurite-to-run-automated-tests), 2025-08-25). As a devDependency, the test suite could start it in-process inside the `test` stage with no CI networking.
- GitHub Actions service containers work similarly (`services:` with `ports:` and an optional `command`) ([docs](https://docs.github.com/en/actions/use-cases-and-examples/using-containerized-services/about-service-containers)). They aren't in use here.

**What Azurite doesn't support** (README support matrix):
- **Blob versions**
- **Soft delete and undelete, for blobs and containers**
- Static website, object replication, incremental copy, blob query, last access time, blob expiry, immutability policies and legal hold, encryption scopes
- Hierarchical namespace (Data Lake Gen2) ([Microsoft](https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite))

**What it does support:**
- **Conditional headers (If-Match, If-None-Match)**
- **Leases**
- Snapshots
- Account and service SAS
- Blob tags (preview)
- **Blob Batch** (since 3.20.0)

**Token auth** works only with `--oauth basic` over HTTPS. Even then, Azurite checks a token's issuer, audience and expiry, but **not its signature or RBAC**. A managed-identity or role-assignment path can't be truly tested on Azurite.

---

## 5. Rendering

- **Pandoc reads local files and writes a local file.** The native render writes the compiled Markdown to a scratch file in the OS temp folder and does the same with the Instance-logo reference document. It runs `pandoc ... -o <target> <scratch.md>` and removes the scratch files afterwards (`lib/render.js:1187-1235`).
- **The web UI's render for a server workspace never writes `out/`.** It passes `deliverToClient: true`. The `.docx` is produced in the temp folder, read back into memory, returned to the browser as base64, and deleted (`lib/server.js:6103-6121`; `lib/render.js:1164-1170`, `:1195`, `:1227-1230`).
  - Only the **CLI** (`gantry render`, `README.md:385`) and a direct `.md` render write `out/` and the render manifest (`lib/render.js:1177-1178`, `:1197`, `:82-101`, `:1334`).
  - So for a server, "persist outputs to blob" is optional. Today nothing persists them.
- **What the render code assumes about paths. Every input is read as a local file:**
  - **Module and instance data** go through `readInstance` and `readModule` (`lib/render.js:1316-1323`), which use the seam.
  - **Images:**
    - `asset:<id>` references are rewritten to an **absolute local path** for Pandoc (`lib/assets.js:106-113`).
    - The WASM render path reads those same absolute paths back to send the bytes to the browser (`lib/render.js:1263-1290`).
  - **Instance logo:** read from `join(instancesDir, slug)` on disk (`lib/render.js:1112`; `lib/instanceLogo.js:79-83`).
  - **The Definition's reference `.docx`** is checked with `existsSync` in the Definition's folder (`lib/render.js:1099-1103`). For a server workspace Definition, that folder is inside the workspaces root.
  - **Templates and the Document Control partial** are read from the Definition folder (`lib/render.js:943`, `:183-189`).
- **There is already a precedent for "copy to local disk, then render".** Every Provider render copies the repo's `assets/` to local disk before Pandoc runs, then pushes the output back:
  - copying assets: `lib/render.js:815-862`, `:866+`, called at `:1434` and `:1522`
  - pushing the output: `lib/render.js:1466-1500`
  - The browser local-workspace compile builds its whole tree in a temp folder and deletes it afterwards (`lib/localWorkspace.js:328-401`).
  - So yes, Pandoc can run on a local scratch copy, and the code already works that way. A blob render would download the instance's needed files (or keep a local copy) and leave `compileArtefact` unchanged.

---

## 6. Sync vs async

### What an async seam would touch
- **`lib/instance.js` is already mostly async-tolerant.** Its read and write functions return a value for local data and a Promise for a Provider (documented at `lib/instance.js:1402` and `:2163`). Counted with `grep` over `lib/` and `bin/`, excluding `lib/instance.js`:

  | Function | Call sites | Already awaited |
  |---|---|---|
  | `readInstance` | 101 | 87 |
  | `readModule` | 22 | 15 |
  | `writeInstanceStage` | 9 | 8 |
  | `createInstance` | 4 | 2 |
  | `writeModules` | 3 | 2 |
- **About 30 local call sites are not awaited** and would need to change. They are in:
  - routes in `lib/server.js` (for example `:3468`, `:4725`, `:5418-5439`, `:5593`, `:5649-5656`, `:5862-5882`, `:5978-5995`, `:6096`, `:6152`, `:6488`)
  - the local render path (`lib/render.js:1316-1322`)
  - `lib/check.js:77`, `lib/status.js:356`, `lib/stageAdvancement.js:41-51`, `lib/assets.js:43`
  - `lib/registry.js:88`
  - the CLI (`bin/gantry.js:226`)
- **Synchronous throughout today, and would all become async:**
  - **Registries:** imported by 7, 8 and 4 files (workspace, instance and number registries).
  - **`resolveLocalDataDir`:** reads the registry and is called 27 times in `lib/server.js` (`:680`).
  - **`lib/workspaceDirectory.js`:** imported by 6 files.
  - **`lib/definition.js`:** imported by 23 files, but only server workspace Definitions live in the workspaces root.
  - **Stage status:** `lib/status.js`, imported by 6 files. Its local `evaluateStage` reads files directly.
  - **`lib/check.js`, `lib/stageAdvancement.js` and the CLI commands.**
- **Tests:** 92 of 255 test files import `lib/instance.js`, and 145 build fixtures with `mkdtempSync`. Most of these write files directly. They would keep working against a local backend, but they wouldn't exercise a blob one.
- **The request handler is already `async`** (`lib/server.js:1455`). Awaiting inside routes is not new.

### Local copy filled at startup, written through on every save
- **What stays the same:** every existing code path, including the bypasses in part 1, keeps reading local files. Pandoc's assumptions hold.
- **What it needs:**
  1. A full download at boot: list by prefix, then one Get per blob. Startup time grows with the data.
  2. Every write mirrored to blob. That includes the bypasses (assets, logos, Definitions, the library cache), or those stay local and are lost on redeploy.
  3. Directory operations (`renameSync` in migration and Definition publish, `cpSync` for draft and clone, recursive `rmSync` in the library cache) turned into copy and delete of many blobs, none of which is atomic.
- **Two replicas.** Each replica's local copy goes stale as soon as the other one writes, and registries read "fresh" from local disk (`lib/numberRegistry.js:19`) would be fresh only for that replica. Ways to keep it safe:
  - **(a)** Stay single-replica, as Render's disk already forces.
  - **(b)** Check freshness on read with a HEAD or a conditional GET per blob (one cheap request; see part 2). Gantry already does exactly this for shared Provider workspaces: it checks `getBranchObjectId` before serving a cached value (`lib/sharedWorkspaceCache.js:1-20`).
  - **(c)** Use `If-Match` on every write-through, so a stale replica's write fails instead of overwriting.
  - The registries' read-modify-write with no lock (`lib/instanceRegistry.js:621-641`) needs (c) in any multi-writer setup, whichever seam is chosen.

### How ADR-0068's stage version could map onto ETags
ADR-0068 (on `docs/246-ai-drafting`) has Gantry note the stage's content when a session or editor reads it, then compare again at every Save. Clashes are settled Field by Field from three sides: what the saver started from, what is committed now, and what the saver has. MCP's `get_instance` returns a stage **version** and `update_instance_modules` takes it.
- **No version exists for a server workspace today.** Local saves are plain overwrites (`lib/instance.js:2266-2268`). The Provider writes' `oldObjectId` is fetched just before the push (`lib/azureDevOpsClient.js:255-272`), so it guards a single push, not "since you read it".
- **What an ETag gives:** each module blob's ETag tells whether *that file* changed since it was read, and `If-Match` makes the write fail if it did. A stage version could be:
  - **(a)** the set of ETags of the stage's module blobs (plus `instance.yaml`), or a hash of them; or
  - **(b)** the ETag of one blob per stage, if a stage's modules were stored together.
- **What an ETag doesn't give:**
  - **The base.** A three-way, Field-by-Field merge needs the content the saver started from. On git that is the old commit. On blob, without versioning, the old bytes are gone once overwritten, and Azurite has no versioning at all. So the base has to travel with the saver (the browser or the MCP agent already holds what it read), or be stored by Gantry.
  - **All-or-nothing across modules.** A multi-module Save writes several blobs. `If-Match` on each can leave a partial Save if a later one fails. Options: check all ETags first (a race is still possible between check and write), take a short **lease** on one per-instance or per-stage blob during the Save, or store a stage's modules as one blob.
- A content hash of the stage's module text would also work as the version, with no blob at all, so the same version scheme would cover local disk and blob. That is a choice for #212 and ADR-0068's build.

---

## Not verified
- Whether real Azure returns **409 or 412** for Put Blob with `If-None-Match: *` (Azurite returns 409).
- An explicit Microsoft sentence that Set Blob Metadata changes the ETag (inferred from "every write").
- Any numeric latency for Standard or Premium. None is published.
- That Render has no managed identity (inferred from its docs not mentioning one).
- Whether the JS SDK accepts the short form `UseDevelopmentStorage=true`.
- Whether a `docker build` `RUN` step can reach an Azure Pipelines service container without extra networking.
- Prices are for East US only, from the Retail Prices API.
