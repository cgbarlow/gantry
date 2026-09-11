import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'
import {
  resolveInstanceLocation,
  listRegisteredInstances,
  MIGRATED_DEFAULT_WORKSPACE_FOLDER,
} from './instanceRegistry.js'
import { writeWorkspaceJson } from './workspaceDirectory.js'
import { describeInstance, listInstanceSlugs } from './instance.js'

/**
 * WI #370: the one place that answers "given a slug and a workspaces root, which directory actually
 * holds this instance's files?" — shared by `gantry serve`'s per-request routes (lib/server.js) and by
 * every slug-taking CLI command (bin/gantry.js).
 *
 * This module exists because those two sides had drifted apart. WI #356/#366 taught the *server* the
 * two-level `workspaces/<workspace>/<slug>/` layout, as a private `resolveLocalDataDir` inside
 * lib/server.js; WI #358 then repointed the *CLI*'s default data directory at the same workspaces root
 * without giving it any equivalent, so every CLI command went looking one level too high and found
 * nothing (`gantry instances` reporting "No instances found." against a directory the dashboard listed
 * two instances from). Keeping the resolution in a module both import is what stops that happening
 * again: there is no longer a server-side answer and a CLI-side answer that can disagree.
 */

export { MIGRATED_DEFAULT_WORKSPACE_FOLDER }

/**
 * `slug`'s concrete data directory under `workspacesDir`, resolved through the instance registry
 * (lib/instanceRegistry.js) rather than assumed.
 *
 * Three cases, in the order they matter:
 * - a registered `{ kind: 'directory' }` entry resolves to `join(workspacesDir, <its workspace>)`;
 * - a slug the registry has never seen falls back to `workspacesDir` itself, which is exactly how a
 *   pre-0.4 flat data directory has always been read — `--workspaces-dir` pointed at one of those keeps
 *   working, as `resolveEffectiveWorkspacesDir`'s own contract in bin/gantry.js promises;
 * - an Azure-DevOps-backed entry also falls back to `workspacesDir`, because it has no local directory
 *   at all; callers that can talk to Azure DevOps (the server) check `resolveInstanceLocation`
 *   themselves first and never reach here for one.
 *
 * `options.workspace` scopes the lookup to a single workspace, the same way `resolveInstanceLocation`
 * takes it — this is what the CLI's `<workspace>/<slug>` address form passes through.
 *
 * A slug registered in more than one workspace is genuinely ambiguous, and what should happen then
 * differs by caller, so `options.strict` picks:
 * - **omitted (the default)** — fall back to `workspacesDir`, never throw. This is the contract
 *   `lib/server.js` has had since WI #356: a route resolves a slug per request and reports whatever
 *   `readInstance` itself says about the directory it landed on, rather than surfacing a resolution
 *   error invented at this layer.
 * - **`true`** — rethrow the registry's own error, which names every candidate workspace and the
 *   qualified form to retry with. The CLI wants this: telling someone their slug is ambiguous is far
 *   more use at a terminal than silently picking one of two instances that share it, or reporting a
 *   "no such instance" for a directory they never asked about.
 *
 * Any *other* failure to read the registry falls back to `workspacesDir` on both paths, so a malformed
 * or unreadable registry degrades to pre-0.4 behavior instead of taking every command down with it.
 */
export function resolveInstanceDataDir(slug, workspacesDir, options = {}) {
  let location
  try {
    // `options` is spread through untouched, so a caller can pass anything `resolveInstanceLocation`
    // understands — `workspace`, `scopeId`, and `suppressBareSlugWarning`, which the CLI sets because
    // the registry's "prefer <workspace>/<slug>" deprecation notice is aimed at code addressing
    // instances programmatically, not at a person typing the bare form this project's own README and
    // `--help` still teach. The server deliberately doesn't set it, so its logs keep that signal.
    location = resolveInstanceLocation(slug, { ...options, instancesDir: workspacesDir })
  } catch (err) {
    if (options.strict && isAmbiguousSlugError(err)) throw err
    return workspacesDir
  }
  return location?.kind === 'directory' ? join(workspacesDir, location.workspace) : workspacesDir
}

// `resolveInstanceLocation` signals "this bare slug exists in more than one workspace" by throwing;
// every other throw from it is a registry-read problem we'd rather degrade on than crash for. The
// registry builds that error in one place (`ambiguousSlugError`) and it always names both the slug and
// the workspaces to pick between, so matching on the message is enough to tell the two apart without
// exporting a bespoke error class purely for this check.
function isAmbiguousSlugError(err) {
  return /more than one workspace/i.test(err?.message ?? '')
}

/**
 * Every directory-backed instance under `workspacesDir`, as the same `{ slug, definition, stage,
 * stagesWithData }` rows `lib/instance.js`'s `listInstances` produces, each additionally carrying the
 * `workspace` folder it lives in. Sorted by slug, then workspace — the same order
 * `listRegisteredInstances` uses, and the reason `workspace` is on the row at all: since WI #356 the
 * same slug can legitimately exist in two different workspaces, so a listing that only printed slugs
 * couldn't tell them apart.
 *
 * The listing is the **union** of two sources, so that pointing `--workspaces-dir` at either layout
 * lists what's actually there:
 * - every `{ kind: 'directory' }` registry entry, read from its own workspace's directory;
 * - any bare instance directory sitting directly under `workspacesDir` with no registry entry — a
 *   pre-0.4 flat data directory, or an instance created by an older `gantry new`. These come back with
 *   `workspace: null`, which is the honest answer: they aren't in a workspace yet. `gantry serve`
 *   migrates them into the `default` workspace on first start.
 *
 * Azure-DevOps-backed entries are left out entirely: reading one needs a PAT and a network call, which
 * is the dashboard's job (`lib/registry.js`'s `listRegistry`), not this offline directory listing's.
 * An instance whose registry entry points at a directory that has since been deleted is skipped rather
 * than throwing, so one stale entry can't hide every healthy instance beside it.
 */
export function listWorkspaceInstances(workspacesDir, options = {}) {
  const definitionsDir = options.definitionsDir
  const rows = []

  let registered = []
  try {
    registered = listRegisteredInstances({ instancesDir: workspacesDir })
  } catch {
    // A registry that can't be read shouldn't mean "no instances" — fall through to the bare-directory
    // scan below, which is all a pre-0.4 layout ever had anyway.
  }

  for (const entry of registered) {
    if (entry.location.kind !== 'directory') continue
    const instancesDir = join(workspacesDir, entry.workspace)
    if (!storage.exists(join(instancesDir, entry.slug, 'instance.yaml'))) continue
    rows.push({ ...describeInstance(entry.slug, { instancesDir, definitionsDir }), workspace: entry.workspace })
  }

  // A registered instance always lives one level deeper than this scan reaches
  // (`<root>/<workspace>/<slug>/`), so these two sources address disjoint directories and need no
  // de-duplication — the one case where the same slug shows up twice is a bare directory left behind
  // beside its own migrated copy, which really is two directories on disk and is reported as such.
  for (const slug of listInstanceSlugs(workspacesDir)) {
    rows.push({ ...describeInstance(slug, { instancesDir: workspacesDir, definitionsDir }), workspace: null })
  }

  return rows.sort((a, b) => a.slug.localeCompare(b.slug) || (a.workspace ?? '').localeCompare(b.workspace ?? ''))
}

/**
 * Makes sure the reserved `default` server workspace exists under `workspacesDir` as a real,
 * discoverable workspace — i.e. with its own `workspace.json` marker — and returns its data directory.
 *
 * This is the workspace every locally-created instance lands in, whether it was created over HTTP
 * (`POST /api/instances`) or by `gantry new`. The marker file is what makes the registry's own
 * auto-backfill scan (`scanDirectoryWorkspacesForInstances`, which only looks inside real
 * `workspace.json` folders) able to see instances placed there, so creating an instance without it
 * would leave that instance invisible to every listing. Idempotent — an existing marker is never
 * overwritten, so a workspace someone has since renamed or described keeps its own record.
 */
export function ensureDefaultWorkspace(workspacesDir) {
  const instancesDir = join(workspacesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER)
  if (!storage.exists(join(instancesDir, 'workspace.json'))) {
    writeWorkspaceJson(workspacesDir, MIGRATED_DEFAULT_WORKSPACE_FOLDER, {
      name: 'default',
      kind: 'local',
      createdAt: new Date().toISOString(),
    })
  }
  return instancesDir
}
