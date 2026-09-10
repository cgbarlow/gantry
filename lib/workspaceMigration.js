import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'
import { listInstanceSlugs } from './instance.js'
import { writeWorkspaceJson } from './workspaceDirectory.js'
import { MIGRATED_DEFAULT_WORKSPACE_FOLDER } from './instanceRegistry.js'

/**
 * WI #356 (Feature 2 of 4, workspace-directories epic #34): migrates a pre-#356 flat workspaces root
 * — one whose immediate children are bare instance directories (`instance.yaml` right there, no
 * `workspace.json` one level up the way a real server workspace folder has) — into the current
 * layout, by moving every such child under a new `default/` server workspace.
 *
 * Deliberately does nothing to `instance-registry.json`/`number-registry.json` itself: once the
 * directories are physically under `default/` (a real server workspace, `MIGRATED_DEFAULT_WORKSPACE_FOLDER`),
 * `lib/instanceRegistry.js`'s own `migrateLegacyFlatShape` — run automatically the next time anything
 * reads the registry, the same "auto-backfill on read" convention every registry in this codebase
 * already follows — converts any old flat-shaped entries onto the scope `default` maps to
 * (`scopeIdForDirectoryFolder('default')`, which is the reserved `LOCAL_SCOPE`, `'local'`) with the
 * `archived` flag carried across unchanged. `number-registry.json` is untouched by any of this: a
 * migrated instance keeps the exact instance number it already had under the shared local scope
 * (`LOCAL_SCOPE`), and that scope's workspace number stays the reserved `LOCAL_WORKSPACE_NUMBER` (0)
 * — nothing in `lib/numberRegistry.js` has to change or even run for a pre-migration `w0i1`-style
 * reference to resolve to the same instance afterward.
 *
 * Idempotent: once every bare child has moved, a second call finds none left at the workspaces
 * root and is a no-op. Safe against a workspaces root that doesn't exist yet at all (a brand new
 * install) — `listInstanceSlugs` already treats a missing directory as "no slugs", not an error.
 */

/** What a migration would do, without touching disk: `{ legacySlugs, targetFolder }`. */
export function planWorkspaceMigration(workspacesDir) {
  return { legacySlugs: listInstanceSlugs(workspacesDir), targetFolder: MIGRATED_DEFAULT_WORKSPACE_FOLDER }
}

/**
 * Runs the migration for real (or, with `options.dryRun`, only reports the plan — identical to
 * `planWorkspaceMigration` plus `dryRun: true`, nothing on disk changes). Returns
 * `{ migrated: string[], targetFolder, dryRun? }`. Logs a one-line summary to the console when it
 * actually moves anything, matching this codebase's existing "one diagnostic breadcrumb" convention
 * for startup-time/maintenance operations (see e.g. `lib/registry.js`'s own `console.error` note).
 */
export function migrateLegacyWorkspaceDirectory(workspacesDir, options = {}) {
  const { legacySlugs, targetFolder } = planWorkspaceMigration(workspacesDir)
  if (legacySlugs.length === 0) return { migrated: [], targetFolder }
  if (options.dryRun) return { migrated: legacySlugs, targetFolder, dryRun: true }

  if (!storage.exists(join(workspacesDir, targetFolder, 'workspace.json'))) {
    writeWorkspaceJson(workspacesDir, targetFolder, {
      name: 'default',
      kind: 'local',
      createdAt: new Date().toISOString(),
    })
  }
  for (const slug of legacySlugs) {
    renameSync(join(workspacesDir, slug), join(workspacesDir, targetFolder, slug))
  }
  console.log(
    `gantry: migrated ${legacySlugs.length} legacy instance(s) into the "${targetFolder}" server workspace: ${legacySlugs.join(', ')}`
  )
  return { migrated: legacySlugs, targetFolder }
}
