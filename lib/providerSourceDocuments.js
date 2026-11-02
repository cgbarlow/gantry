import { AZURE_DEVOPS_WORKSPACE_ROOT } from './instance.js'
import { NotFoundError } from './providerErrors.js'
import { providerClient } from './reviews.js'
import { nearestEarlierStageBranch } from './stageBranch.js'
import { SourceDocumentError, USE_AS_IMAGE_REFUSAL, assetFilenameForSource, canUseSourceAsImage, createSourceStore } from '../web/lib/sourceDocuments.js'

// #280 (map #238, decided in #245 and #242): an Instance's **Source documents** on an Azure DevOps or GitHub workspace. The folder, the manifest and the lifecycle are web/lib/sourceDocuments.js's, shared with a Local workspace and a server workspace; this file supplies the Provider's half of the file interface that module is written against, and the rule that makes a Provider different:
//
//   - **One operation is one commit.** An upload (the original, its extracted text and the manifest), a rename, an Extract text again and a removal each change several files; they are collected while the shared lifecycle runs and land together as a single `writeFiles` commit. They are never part of a stage Save.
//   - **On the current Stage's branch**, as Assets are: the branch is started (stacked on the nearest earlier Stage's branch, or `main`) only by an operation that actually changes something, so a refused upload or a read starts nothing. A later Stage's branch is cut from an earlier one's, so it carries the documents; they reach `main` when that Stage's Pull Request merges.
//   - **Later reads use what is committed**: the manifest and the extracted text come from the branch, never from a binary read-back of the original.
//
// Two people changing the list at once are settled by the Provider: the second commit is built on a branch tip that has moved, which both Providers refuse, and the operation is run again from the new tip.

const repoPath = (slug, relative) => `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/${relative}`

const isMissing = (err) => err instanceof NotFoundError || err?.name === 'NotFoundError' || err?.name === 'GitHubNotFoundError'

// A branch tip that moved between reading and writing: GitHub answers 422 ("not a fast forward"), Azure DevOps 409.
const MOVED_TIP_STATUSES = new Set([409, 412, 422])
const MAX_COMMIT_ATTEMPTS = 3

/** The Provider option keys Source documents are kept on (GitLab and Atlassian join when their module Save lands). */
export const SOURCE_PROVIDER_KEYS = ['azureDevOps', 'github']

/**
 * The branch a read of the Source documents uses, without starting one: the current Stage's own branch when it has begun, else the nearest earlier Stage's (the branch the current Stage's would be cut from), else `undefined` for `main`. `options` is `{ azureDevOps | github: { ...location, pat } }`.
 */
export async function findSourceReadBranch(options, definition, slug, stageId) {
  const stageIndex = definition.stages.findIndex((stage) => stage.id === stageId)
  if (stageIndex === -1) return undefined
  const { client } = providerClient(options)
  // `nearestEarlierStageBranch` looks at the stages before the index it is given, so passing the one after the current Stage includes the current Stage itself.
  const branch = await nearestEarlierStageBranch(client, definition, slug, stageIndex + 1)
  return branch === 'main' ? undefined : branch
}

/** The read half of the file interface: text and bytes from `branch` (`main` when none), `null` when a file is not there. */
function readerFor(client, slug, branch) {
  const ref = branch ?? 'main'
  return {
    async readText(path) {
      try {
        const text = await client.getFileContent(repoPath(slug, path), { branch: ref })
        // A repository keeps no version of a file to condition a write on, so the text itself stands for it.
        return { text, version: text }
      } catch (err) {
        if (isMissing(err)) return null
        throw err
      }
    },
    async readBytes(path) {
      try {
        return new Uint8Array(await client.getFileBytes(repoPath(slug, path), { branch: ref }))
      } catch (err) {
        if (isMissing(err)) return null
        throw err
      }
    },
  }
}

/** A file interface that reads through `reader` but holds every write and removal back, to be committed together. */
function stagingIo(reader) {
  const written = new Map()
  const removed = new Set()
  return {
    written,
    removed,
    async readText(path) {
      if (written.has(path)) {
        const entry = written.get(path)
        return typeof entry === 'string' ? { text: entry, version: entry } : null
      }
      return removed.has(path) ? null : reader.readText(path)
    },
    async readBytes(path) {
      if (written.has(path)) {
        const entry = written.get(path)
        return typeof entry === 'string' ? null : entry
      }
      return removed.has(path) ? null : reader.readBytes(path)
    },
    async writeText(path, text) {
      removed.delete(path)
      written.set(path, text)
    },
    async writeBytes(path, bytes) {
      removed.delete(path)
      written.set(path, bytes)
    },
    async remove(path) {
      written.delete(path)
      removed.add(path)
    },
  }
}

const readOnlyRefusal = async () => {
  throw new Error('This Source documents store is read-only.')
}

/**
 * The store for one Provider-hosted Instance's Source documents, with the methods of `createSourceStore` (web/lib/sourceDocuments.js). `options` is `{ azureDevOps | github: { ...location, pat } }` with no branch. `readBranch` is where reads come from (`findSourceReadBranch`). `resolveWriteBranch()` starts the current Stage's branch if it has not begun and returns its name; it is called only once an operation has something to commit. `now` is a test's fixed clock.
 */
export function createProviderSourceStore(options, slug, { readBranch, resolveWriteBranch, now } = {}) {
  const { client } = providerClient(options)
  const storeOptions = now ? { now } : {}
  const reader = readerFor(client, slug, readBranch)
  const readOnly = createSourceStore({ ...reader, writeText: readOnlyRefusal, writeBytes: readOnlyRefusal, remove: readOnlyRefusal }, storeOptions)

  // Runs `operation(store)` against a staging interface, then commits what it staged as one commit.
  async function commitOne(operation, describe) {
    for (let attempt = 1; ; attempt++) {
      const io = stagingIo(reader)
      const result = await operation(createSourceStore(io, storeOptions), io)
      if (io.written.size === 0 && io.removed.size === 0) return result
      const branch = await resolveWriteBranch()
      const files = [...io.written].map(([path, content]) =>
        typeof content === 'string'
          ? { path: repoPath(slug, path), content }
          : { path: repoPath(slug, path), content: Buffer.from(content).toString('base64'), contentType: 'base64encoded' }
      )
      try {
        await client.writeFiles(files, { branch, message: describe(result), deletePaths: [...io.removed].map((path) => repoPath(slug, path)) })
        return result
      } catch (err) {
        if (!MOVED_TIP_STATUSES.has(err?.status) || attempt >= MAX_COMMIT_ATTEMPTS) throw err
      }
    }
  }

  return {
    list: () => readOnly.list(),
    readOriginal: (id) => readOnly.readOriginal(id),
    readText: (id) => readOnly.readText(id),
    upload: (data) => commitOne((store) => store.upload(data), ({ entry }) => `Add Source document "${entry.title}"`),
    rename: (id, title) => commitOne((store) => store.rename(id, title), (entry) => `Rename Source document "${entry.id}" to "${entry.title}"`),
    remove: (id, removal) => commitOne((store) => store.remove(id, removal), (entry) => `Remove Source document "${entry.title}"`),
    /**
     * **Use as image** (#281): copies the document into the Instance's `assets/` folder as a new file of its own, one commit on the current Stage's branch like every other change here, the way a Provider keeps every image (referenced as `![alt](assets/<name>)`, no manifest). It keeps no link back to the document. Returns `{ asset, reference }`.
     */
    useAsImage: (id, { uploadedBy = '' } = {}) =>
      commitOne(
        async (store, io) => {
          const { entry, bytes } = await store.readOriginal(id)
          if (!canUseSourceAsImage(entry.filename)) throw new SourceDocumentError(USE_AS_IMAGE_REFUSAL, { code: 'not-an-image', status: 400 })
          if (!bytes) throw new SourceDocumentError(`The file for "${entry.title}" is not in the repository.`, { code: 'file-missing', status: 404 })
          let taken = []
          try {
            taken = (await client.listFolder(repoPath(slug, 'assets'), { branch: readBranch ?? 'main' })).filter((item) => !item.isFolder).map((item) => item.path.split('/').pop())
          } catch (err) {
            if (!isMissing(err)) throw err
          }
          const filename = assetFilenameForSource(entry.filename, taken)
          await io.writeBytes(`assets/${filename}`, bytes)
          return {
            asset: { id: filename, filename, name: entry.title, source: '', uploadedBy },
            reference: `![${entry.title.replace(/[[\]]/g, '')}](assets/${filename})`,
          }
        },
        ({ asset }) => `Copy Source document "${asset.name}" to the images as ${asset.filename}`
      ),
    setText: (id, text) => commitOne((store) => store.setText(id, text), (entry) => `Extract text again for Source document "${entry.title}"`),
  }
}
