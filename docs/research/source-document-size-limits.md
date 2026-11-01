# Source document size limits per Provider

Research for [#242](https://github.com/cgbarlow/gantry/issues/242), part of the v0.13.0 AI interview map [#238](https://github.com/cgbarlow/gantry/issues/238).

**Question.** Architects upload Source documents (PDF, Word, spreadsheets, PowerPoint, images) to an Instance, and Gantry commits them to the workspace's Provider repo. What size limits does each Provider's content API set? What limits does Gantry's own code set? What per-document ceiling should Gantry enforce?

Researched 2026-11-01, against `main` at `65924c7` (v0.12.1).

## Answer in brief

- **Every Provider caps a single file at 100 MB.** GitHub and Azure DevOps state this; Bitbucket Cloud does it through a block setting that is on by default. Nothing documented goes higher without Git LFS.
- **None of the commit APIs Gantry uses can write Git LFS objects.** Gantry would have to implement the LFS batch protocol itself. LFS is not an option for v0.13.0.
- **Gantry's binary transport is base64 inside JSON.** A file grows by about a third on the wire, and the whole request is held in memory more than once on its way through.
- **Reading files back is the tighter constraint, not writing them.** Gantry's GitHub client can't read back, or even overwrite, a file larger than 1 MB. Its Azure DevOps client has no reliable way to read binary files at all. The AI needs to read Source documents, so this has to be fixed whatever ceiling is chosen.
- **Recommendation: a ceiling of 25 MB per Source document, enforced in the browser and on the server.** Also a soft per-Instance total of about 100 MB, with a warning rather than a block. Upload each document as its own request and commit, not inside a stage Save.

## Hard limits by Provider and path

"Documented" means the vendor's own docs say it. "Not documented" means the primary source is silent; it is not evidence that no limit exists.

| Provider / path | Per-file limit | Request / push limit | Binary handling | Git LFS | Source |
| --- | --- | --- | --- | --- | --- |
| **GitHub**, Git Data API `POST /git/blobs` (what Gantry's `writeFiles` uses) | Blob enforced at **100 MB** (recommended maximum 1 MB). Create-blob docs give no figure. | Push limit 2 GB (git push). No REST payload cap is documented. **Requests that take more than 10 s are terminated.** | `encoding: "base64"` or `"utf-8"` | Not through this API. GitHub blocks files over 100 MiB and says to use LFS. LFS per-file maximum is 2 GB (Free/Pro), 4 GB (Team), 5 GB (Enterprise Cloud). | [Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits), [Blobs](https://docs.github.com/en/rest/git/blobs), [About large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github), [About Git LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage), [Troubleshooting the REST API](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api) |
| **GitHub**, `GET /git/blobs/{sha}` | "supports blobs up to 100 megabytes" | — | base64 JSON by default, or raw with `application/vnd.github.raw+json` | — | [Blobs](https://docs.github.com/en/rest/git/blobs) |
| **GitHub**, Contents API `GET /contents/{path}` (what Gantry's `getFileContent` / `getFileBytes` / `fileExists` use) | **≤ 1 MB**: everything works. **1–100 MB**: "Only the raw or object custom media types are supported"; with `object`, `content` is `""` and `encoding` is `"none"`. **> 100 MB**: "not supported". | — | base64 in JSON up to 1 MB | — | [Contents](https://docs.github.com/en/rest/repos/contents) |
| **GitHub**, Contents API `PUT /contents/{path}` (not used for writes) | Not documented | — | base64 `content` | — | [Contents](https://docs.github.com/en/rest/repos/contents) |
| **GitHub**, web UI | 25 MiB per browser upload | — | — | — | [About large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) |
| **Azure DevOps Services**, Pushes API `POST /pushes` (what Gantry's `writeFiles` uses) | "Files should be no larger than **100 MB**." There is also an optional per-repo **Maximum file size** policy that blocks pushes containing a new or updated file over an admin-chosen size, which may be lower. | **5 GB** per push. The Pushes REST reference documents **no REST request-body cap**. | `newContent.contentType`: `rawtext` or `base64encoded` | LFS doesn't count towards the 5 GB push limit, but the Pushes API takes inline content only. The docs also note "Dragging a binary file into the web interface commits the binary to the repo, not the LFS pointer." | [Git limits](https://learn.microsoft.com/en-us/azure/devops/repos/git/limits?view=azure-devops), [Pushes – Create](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pushes/create?view=azure-devops-rest-7.1), [Repository settings – Maximum file size](https://learn.microsoft.com/en-us/azure/devops/repos/git/repository-settings?view=azure-devops#maximum-file-size-policy), [Manage large files](https://learn.microsoft.com/en-us/azure/devops/repos/git/manage-large-files?view=azure-devops) |
| **Azure DevOps Services**, repository size | — | Keep under 10 GB for performance. Hard ceiling about 250 GB (pack-file limit). | — | Recommended for large binaries | [Git limits](https://learn.microsoft.com/en-us/azure/devops/repos/git/limits?view=azure-devops) |
| **Bitbucket Cloud**, Source API `POST /src` (what Gantry's `writeFiles` uses) | No per-file limit in the endpoint docs. Repo setting **"Block pushes with files over 100 MB"** is enabled by default. | Not documented for the endpoint. A large commit can fail with "pack exceeds maximum allowed size" (threshold not stated). **Repository hard limit 4 GB**: at that point only pushes that undo commits are accepted. Recommended under 2 GB; Free-plan workspaces get 1 GB total. | `multipart/form-data` real bytes (Gantry uses this), or `application/x-www-form-urlencoded` for text | Not through this endpoint. "There's no limit on the LFS file size you can push to Bitbucket Cloud." | [Source API (OpenAPI spec)](https://developer.atlassian.com/cloud/bitbucket/swagger.v3.json) (`/repositories/{workspace}/{repo_slug}/src`), [Reduce repository size](https://support.atlassian.com/bitbucket-cloud/docs/reduce-repository-size/), [Git LFS limitations](https://support.atlassian.com/bitbucket-cloud/docs/current-limitations-for-git-lfs-with-bitbucket/) |
| **Bitbucket Cloud**, `GET /src/{commit}/{path}` | Not documented | — | Raw bytes. An LFS-managed file returns a **301 redirect** to Atlassian media services. | — | [Source API (OpenAPI spec)](https://developer.atlassian.com/cloud/bitbucket/swagger.v3.json) |
| **Gantry** `/api/local/*` (`lib/localWorkspace.js`) | — | **10 MB** raw body (`LOCAL_WORKSPACE_LIMITS.maxBodyBytes`), enforced while streaming by `readBodyWithLimit` (413) | base64 in JSON | — | `lib/localWorkspace.js:35-45`, `lib/server.js:455-505` |
| **Gantry** reference-docx upload routes | — | **15 MB** raw body (`MAX_REFERENCE_DOCX_BODY_BYTES`) | base64 in JSON | — | `lib/server.js:295-302` |
| **Gantry** every other JSON route (`readBody`), including `POST /api/instance/assets` | — | **No cap.** It concatenates chunks into one string until the request ends. | base64 in JSON | — | `lib/server.js:446-453` |
| **Gantry** asset upload (`lib/assets.js`, `POST /api/instance/assets`) | No size check. Extension allow-list `.png .jpg .jpeg` only. | Inherits `readBody`, so uncapped | base64 `dataBase64` in JSON | — | `lib/assets.js:139-190`, `lib/server.js:6500-6606` |
| **Gantry** local workspace (browser File System Access API) | None in Gantry. Bounded by the user's disk and browser memory. | — | `writeBinaryFile` writes `Blob`/typed array directly. `readBinaryFile` reads the whole file into a `Uint8Array`. | — | `web/lib/localWorkspace.js:383-398` |

## What Gantry's code does today

### How each Provider's content store writes files

- **Azure DevOps** (`lib/azureDevOpsClient.js:252-293`, `writeFiles`). This is one `POST /pushes` whose JSON body carries every file's content inline as `newContent.content`, with `contentType: 'base64encoded'` for binary. Before pushing, it calls `fileExists` on every path to choose `add` or `edit`. `fileExists` is `getFileContent` with `includeContent=true`, which downloads each existing file's full content just to learn that it exists.
- **GitHub** (`lib/githubClient.js:354-417`, `writeFiles`). This uses the Git Data API: one `POST /git/blobs` per file (base64 JSON), then a tree, a commit and a ref update. It also calls `fileExists` per path first, and `fileExists` goes through the Contents API (`lib/githubClient.js:174-211`).
- **Bitbucket / Atlassian** (`lib/bitbucketClient.js:465-505`, `writeFiles`). This is one `POST /src` as `multipart/form-data` with real bytes in a `Blob`. Base64 input is decoded first, so there's no base64 on the Bitbucket leg. Its `fileExists` uses the `?format=meta` metadata call (`lib/bitbucketClient.js:389-395`), not a content download.
- **Module Save** (`lib/instance.js:2165-2270`, `writeModule` / `writeModules`). This branches on `options.azureDevOps`, `options.github` or local only. Bitbucket's `writeFiles` is used today for definitions (`lib/definitionAtlassian.js`) and instance creation (`lib/instance.js:981`). `INSTANCE_PROVIDER_LOCATION_RESOLVERS` in `lib/server.js` covers `azure-devops`, `github` and `gitlab` only, with no `atlassian` entry. **I couldn't find a server route that saves modules for an Atlassian-backed Instance.** The map assumes "Atlassian" is a workspace kind where module Save works today; check that before relying on it (see Open questions).

### Assets: the closest existing analogue

`lib/assets.js` handles server and local-disk instances. It writes the decoded bytes under `<instance>/assets/` with a `manifest.yaml`, requires an http(s) `source` URL, and allows `.png/.jpg/.jpeg` only. It has **no size check**.

`POST /api/instance/assets` (`lib/server.js:6500-6606`) dispatches by Provider:

- **Azure DevOps: refused.** Response 400: "Asset uploads are not supported for Workspace-backed instances — commit files to gantry-workspace/<slug>/assets/ in the Azure DevOps repo instead." The reason is in the code comment: "WI260 scoped: repo-as-asset-store has no upload UI yet — committed repo assets only. Keep workspace-backed POST scoped out; a follow-up WI can add upload." That is scope, not a technical limit: the Azure DevOps client already pushes `base64encoded` binary content (the rendered `.docx` artefacts go this way, see `lib/render.js`).
- **GitHub and GitLab: committed** through the content store's `writeFile(..., { contentType: 'base64encoded' })` (#16, #31).
- **Atlassian: no branch.** An Atlassian instance has no location resolver, so the request falls through to the local `createAsset` path. In other words, Atlassian upload isn't wired.

Every branch reads the body with uncapped `readBody`.

Reading assets back shows the binary read gap:

- **Azure DevOps** (`lib/server.js:6609-6700`) reads the file through `getFileContent` (Items API, JSON `includeContent=true`). It then *guesses* whether the string is base64 with a regex, and only for `.png/.jpg/.jpeg`. Anything else is treated as UTF-8 text. The Azure DevOps client has no `getFileBytes`.
- **GitHub** `getFileBytes` decodes `data.content` from the Contents API JSON. For a file over 1 MB the docs say `content` comes back `""` with `encoding: "none"`. `Buffer.from('', 'none')` throws `ERR_UNKNOWN_ENCODING` (checked on Node 24). So above 1 MB, `getFileBytes` fails, and so does `fileExists`, which means *overwriting* an existing file over 1 MB fails too. *Inference from the docs plus the code; not yet reproduced against live GitHub.*
- **Bitbucket** `getFileBytes` reads the raw `GET /src/...` bytes, which works at any size. An LFS-tracked path would get a 301 to media services.

### Gantry's own request-body caps

- `readBody` (`lib/server.js:446-453`) has **no cap**. It builds one string with `data += chunk`. Base64 JSON is ASCII, so the chunk-boundary UTF-8 problem doesn't arise. But one request can force the server to hold an arbitrarily large string, and `JSON.parse` plus `Buffer.from(..., 'base64')` then holds roughly two more copies.
- `readBodyWithLimit` (`lib/server.js:455-505`) was added in WI #299 (docs/adr/0029) precisely because an unbounded `readBody` on an unauthenticated route is a memory-exhaustion vector. It stops buffering once the limit is crossed and returns 413. It's used for `/api/local/*` at 10 MB and for reference-docx uploads at 15 MB.
- **`/api/local/*` isn't on the Source-document path**, and shouldn't be put on it. `buildLocalComputePayload` (`web/app.js:299-333`) sends only `instance.yaml`, the module `.md` files, the instance Logo and an inline definition, not the whole `assets/` folder. As long as Source documents are left out of that payload, the 10 MB cap doesn't constrain them. Adding them would break renders for any Instance holding more than about 7 MB of documents (10 MB ÷ 4/3).

### Local workspaces

A local workspace's files never reach the server for storage (ADR-0029). `writeBinaryFile` / `readBinaryFile` (`web/lib/localWorkspace.js:383-398`) write and read through the File System Access API with no Gantry limit. The only limits there are the user's disk and the tab's memory. Size still matters for local workspaces in one place: the **AI call**. `gantry serve` proxies AI requests (map decision), so whatever extracted text or file bytes go to the AI Provider pass through a server route. That route must use `readBodyWithLimit`, not `readBody`. The AI Provider's own request limits are out of scope here.

## Git LFS: why it doesn't help in v0.13.0

None of the three commit APIs Gantry uses (`POST /git/blobs`, `POST /pushes`, `POST /src`) has any LFS parameter. Each writes the bytes into the repo as an ordinary blob. Using LFS would mean speaking the LFS batch API to upload the object and then committing a pointer file in its place: a new protocol client per Provider, plus LFS-aware reads (Bitbucket's 301 redirect, for instance). Azure DevOps also says its web UI commits the binary rather than the pointer, and LFS isn't supported over SSH.

*Inference:* if a workspace repo's `.gitattributes` already tracks `*.pdf` (or similar) with LFS, Gantry's REST commits will still land full binaries. A teammate cloning with git-lfs will then see "should have been pointers" warnings. Gantry should leave `.gitattributes` alone and document this.

## Practical per-document ceiling

**Enforce 25 MB per Source document (25 × 1024 × 1024 bytes of raw file), checked in the browser before upload and again on the server.**

Why 25 MB:

1. **Well below the 100 MB per-file limit on all three Providers.** That leaves room for an admin's lower Azure DevOps *Maximum file size* policy in common configurations, though not all of them. Gantry should surface a policy rejection message verbatim.
2. **Base64 inflation.** 25 MB becomes about 33.4 MB of JSON per request on the Azure DevOps and GitHub legs. The route cap can then be about 35 MB (`readBodyWithLimit`), in line with the existing 10 MB and 15 MB caps rather than an order of magnitude above them.
3. **GitHub's 10-second processing timeout.** A blob creation from a request this size is plausible inside 10 s, but 100 MB-class requests are not something to count on. *Not measured; test a 25 MB blob create against github.com in the build ticket.*
4. **Matches GitHub's own browser-upload limit (25 MiB),** so the cap is easy to explain: "the same limit as uploading to GitHub in the browser".
5. **Covers the expected documents.** Typical architecture PDFs, Word documents, spreadsheets and image-heavy PowerPoints are usually well under 25 MB. A deck with embedded video won't be; the error should say to compress it or export to PDF.

Alongside it:

- **Soft per-Instance total of about 100 MB of Source documents,** shown as a warning, not a block. Git keeps every version forever, and Bitbucket's hard repository limit is 4 GB (1 GB per workspace on Free). A few Instances of re-uploaded 25 MB decks would add up.
- **One document per request and one commit per upload,** separate from a stage Save. Batching several 25 MB files into one Save would put a 100 MB-plus JSON body through one push. That runs into the GitHub timeout and memory pressure, and makes the Save's "all or nothing" fail for a reason the architect can't see.
- **Make one constant the single source of truth.** Have the browser picker and the server route read it, for example `SOURCE_DOCUMENT_LIMITS = { maxFileBytes: 25 MiB, maxBodyBytes: 35 MiB }`, mirroring `LOCAL_WORKSPACE_LIMITS`.

### Work this implies, whatever ceiling is chosen

1. **GitHub reads above 1 MB.** `getFileBytes` (and `fileExists`) must request `Accept: application/vnd.github.raw+json` (Contents API, up to 100 MB) or read via `GET /git/blobs/{sha}` (up to 100 MB). `fileExists` should not download content at all.
2. **Azure DevOps binary reads.** Add a real `getFileBytes`, for example Items API with `$format=octetStream` / `download=true`, to replace the regex base64 sniffing. *That parameter's behaviour wasn't verified in this research.* `fileExists` should stop downloading full content: use `includeContentMetadata` or the item's own metadata.
3. **Cap the upload route** with `readBodyWithLimit`. Better still, move the remaining `readBody` callers off it where they accept user data. That's an existing gap, not new.
4. **Wire Azure DevOps and Atlassian upload.** The Azure DevOps refusal is scope (WI260), not a Provider limit. Atlassian has no upload branch at all.

## Open questions (not answerable from primary sources)

- **The Azure DevOps Pushes REST body limit isn't documented.** No Microsoft page states a maximum JSON request size for `POST /pushes`. Test a 25 MB `base64encoded` push against a real organisation before shipping.
- **Bitbucket `POST /src` request-size limit isn't documented.** The 100 MB block setting and the 4 GB repository limit are the only published figures.
- **Atlassian module Save.** This research didn't find a server path that saves modules for an Atlassian-backed Instance at `65924c7` (see "How each Provider's content store writes files"). Confirm that it works today before the AI interview counts Atlassian among the covered workspace kinds.
- **GitHub's behaviour for files over 1 MB with the default `application/vnd.github+json` media type** (empty `content` versus an error) is inferred from the docs' description of the `object` media type. Either way, Gantry's current decode fails.
