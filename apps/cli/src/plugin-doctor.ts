/**
 * `dsh plugin --profile <name> doctor` — activation-layer diagnostics without
 * modifying the profile. It expands `dsh.bundle.requires`, applies duplicate
 * insert normalization, and reports conflicts, cycles, and likely duplicate
 * module instances that the Loader would otherwise surface as low-level
 * startup failures.
 * @module @deepseek-ai/dsh/plugin-doctor
 */

import { isDeepStrictEqual } from 'node:util'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  composeEntries,
  dedupeActivationPatches,
  loadOptionalPatches,
  loadProfile,
  resolveProfileBundleLayers,
} from '@deepseek-ai/dsh-app-boot'
import { homePatchPath, INSTALL_ANCHOR } from './profile-boot.ts'

const NAME = 'dsh'

/** Return every non-group entry in a loader entry list, including group children. */
function collectEntries(entries: readonly EntryOptions[]): EntryOptions[] {
  const result: EntryOptions[] = []
  const visit = (list: readonly EntryOptions[]): void => {
    for (const entry of list) {
      if (entry.group) {
        if (Array.isArray(entry.config)) visit(entry.config as EntryOptions[])
      } else {
        result.push(entry)
      }
    }
  }
  visit(entries)
  return result
}

/**
 * Run activation diagnostics for one profile.
 * @param profileName - the profile name under `$DSH_HOME/profiles`.
 * @returns 0 when the profile has no fatal activation issue, 1 otherwise.
 */
export function runPluginDoctor(profileName: string): number {
  const errors: string[] = []
  const warnings: string[] = []
  let bundleOrder: string[] = []

  try {
    const profile = loadProfile(NAME, profileName, INSTALL_ANCHOR)
    const bundleLayers = resolveProfileBundleLayers(NAME, profile, INSTALL_ANCHOR)
    bundleOrder = bundleLayers.map(layer => layer.packageName)
    const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
    const patches = dedupeActivationPatches([
      ...bundleLayers.flatMap(layer => layer.patches),
      ...profile.patches,
      ...homePatches,
    ])
    const entries = collectEntries(composeEntries([patches]))

    const byModule = new Map<string, EntryOptions[]>()
    for (const entry of entries) {
      const rows = byModule.get(entry.name)
      if (rows === undefined) byModule.set(entry.name, [entry])
      else rows.push(entry)
    }
    for (const [name, rows] of byModule) {
      if (rows.length < 2) continue
      for (let left = 0; left < rows.length; left += 1) {
        const first = rows[left]
        if (first === undefined) continue
        for (let right = left + 1; right < rows.length; right += 1) {
          const second = rows[right]
          if (second === undefined) continue
          if (first.id !== second.id && isDeepStrictEqual(first.config, second.config)) {
            warnings.push(
              `module ${JSON.stringify(name)} is mounted as ${JSON.stringify(first.id)} and ${JSON.stringify(second.id)} with identical config; `
              + 'if this is a shared singleton it should use one loader entry id',
            )
          }
        }
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  if (errors.length > 0) {
    process.stderr.write(`${NAME}: plugin doctor: profile ${JSON.stringify(profileName)} found ${errors.length} issue(s)\n`)
    for (const issue of errors) process.stderr.write(`- ${issue}\n`)
    return 1
  }

  process.stdout.write(`${NAME}: plugin doctor: profile ${JSON.stringify(profileName)} is healthy\n`)
  if (bundleOrder.length > 0) {
    process.stdout.write(`bundle order: ${bundleOrder.join(' -> ')}\n`)
  }
  for (const warning of warnings) process.stderr.write(`${NAME}: warning: ${warning}\n`)
  return 0
}
