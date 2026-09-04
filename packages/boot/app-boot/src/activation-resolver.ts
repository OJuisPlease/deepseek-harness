/**
 * Minimal activation resolver for profile bundle patches.
 *
 * The loader rejects two entries with the same id in one entry tree
 * (`duplicate loader entry id`). A bundle patch is allowed to `insert` a row
 * that another bundle has already inserted; when the rows are identical this
 * is only a duplicate activation declaration, not a second instance. This
 * module normalizes a flat patch list by removing those duplicate insert
 * declarations before the Loader sees them. Different declarations for the
 * same id fail loud instead of producing the Loader's low-level duplicate
 * error.
 * @module @deepseek-ai/dsh-app-boot/activation-resolver
 */

import { isDeepStrictEqual } from 'node:util'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

interface EntryLocation {
  /** The array containing {@link entry}. */
  list: EntryOptions[]
  /** The live entry object in the simulated tree. */
  entry: EntryOptions
}

/** Simulated loader tree state used while filtering duplicate inserts. */
interface TreeState {
  /** Root entries of the simulated empty-root tree. */
  root: EntryOptions[]
  /** Every known entry id in the simulated tree, including group children. */
  byId: Map<string, EntryLocation>
  /** First declaration snapshot per id, unaffected by later id-targeted overrides. */
  declared: Map<string, EntryOptions>
}

/**
 * Return whether two patch rows are the same activation declaration.
 * `id` is intentionally ignored: callers already know the ids match.
 */
function sameDeclaration(left: EntryOptions, right: EntryOptions): boolean {
  return isDeepStrictEqual(left, right)
}

/** Return the error text for two differing declarations of one id. */
function conflictError(id: string): Error {
  return new Error(
    `activation conflict: duplicate loader entry id ${JSON.stringify(id)} is inserted with different content; `
    + 'identical declarations are merged, differing declarations must use a single owner or an id-targeted override instead of another insert',
  )
}

/** Return a group row's child entries, or undefined when the row is not a group. */
function groupChildren(entry: EntryOptions): EntryOptions[] | undefined {
  if (!entry.group || !Array.isArray(entry.config)) return undefined
  return entry.config as EntryOptions[]
}

/**
 * Validate a new row before it enters the simulated tree. Checks both the
 * existing tree and the local subtree being inserted, so a duplicate inside
 * one insert list fails before it can shadow an earlier row in the same list.
 * @param entry - the row to validate.
 * @param state - current tree state.
 * @param local - ids seen while validating the current subtree.
 * @returns `false` when the row is an exact duplicate of an existing row;
 * `true` when the row is new.
 * @throws when the id exists with different content, or any id repeats inside
 * the inserted subtree.
 */
function validateNewEntry(
  entry: EntryOptions,
  state: TreeState,
  local: Set<string> = new Set(),
): boolean {
  if (typeof entry.id === 'string' && entry.id !== '') {
    if (local.has(entry.id)) throw conflictError(entry.id)
    local.add(entry.id)
    const existing = state.declared.get(entry.id)
    if (existing !== undefined) {
      if (sameDeclaration(existing, entry)) return false
      throw conflictError(entry.id)
    }
  }
  const children = groupChildren(entry)
  if (children !== undefined) {
    for (const child of children) validateNewEntry(child, state, local)
  }
  return true
}

/**
 * Index one already-attached row and every descendant. Rows are not pushed
 * here: callers pass the array that already owns the row, which lets group
 * children be indexed without duplicating them.
 */
function indexEntry(list: EntryOptions[], entry: EntryOptions, state: TreeState): void {
  if (typeof entry.id === 'string' && entry.id !== '') {
    state.byId.set(entry.id, { list, entry })
  }
  const children = groupChildren(entry)
  if (children !== undefined) {
    for (const child of children) indexEntry(children, child, state)
  }
}

/**
 * Append a validated new row to its containing list and index it and all
 * descendants.
 */
function attachEntry(list: EntryOptions[], entry: EntryOptions, state: TreeState): void {
  list.push(entry)
  indexEntry(list, entry, state)
}

/** Record the first declaration snapshot of a row and its descendants. */
function declareEntry(entry: EntryOptions, state: TreeState): void {
  if (typeof entry.id === 'string' && entry.id !== '') {
    state.declared.set(entry.id, entry)
  }
  const children = groupChildren(entry)
  if (children !== undefined) {
    for (const child of children) declareEntry(child, state)
  }
}

/**
 * Add one insert row to a simulated tree list. Exact duplicates are skipped;
 * a different row with the same id throws.
 * @returns true when the row was appended to the output patch; false when it
 * was an exact duplicate and should be dropped.
 */
function addInsertRow(list: EntryOptions[], entry: EntryOptions, state: TreeState): boolean {
  // Keep three separate views: the returned patch row stays pristine, the
  // effective tree is what id-targeted patches mutate, and the declared map is
  // the first-insertion snapshot used for duplicate comparison. If a later
  // insert repeats the original declaration after an id-targeted override, it
  // is still the same declaration and should merge.
  const declaredEntry = structuredClone(entry)
  if (validateNewEntry(declaredEntry, state)) {
    declareEntry(declaredEntry, state)
    const stateEntry = structuredClone(entry)
    attachEntry(list, stateEntry, state)
    return true
  }
  return false
}

/**
 * Apply an id-targeted non-insert patch to the simulated tree. This mirrors
 * the include's single-call patch semantics closely enough to keep duplicate
 * detection comparing against the row state a later patch would see.
 */
function applyOverride(entry: EntryOptions, patch: PatchOptions): void {
  const { name, ...overrides } = patch
  if (name !== undefined && name !== entry.name) return
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'id' || key === 'insert') continue
    if (value === undefined || value === null) {
      Reflect.deleteProperty(entry, key)
    } else {
      ;(entry as unknown as Record<string, unknown>)[key] = value
    }
  }
}

/** A layer that participates in activation dependency ordering. */
export interface ActivationLayerLike {
  /** Stable identity used in `requires` edges, normally a bundle package name. */
  id: string
  /** Identifiers of layers that must precede this layer. */
  requires?: readonly string[]
}

/**
 * Sort layers by their `requires` edges using stable Kahn topological order.
 * Duplicate layer ids collapse to the first occurrence.
 * @param layers - layers to order.
 * @returns layers in deterministic dependency-first order.
 * @throws when a required layer is absent or the graph contains a cycle.
 */
export function sortActivationLayers<T extends ActivationLayerLike>(layers: readonly T[]): T[] {
  const unique: T[] = []
  const indexById = new Map<string, number>()
  for (const layer of layers) {
    if (indexById.has(layer.id)) continue
    indexById.set(layer.id, unique.length)
    unique.push(layer)
  }

  const indegree = new Array<number>(unique.length).fill(0)
  const dependents: number[][] = Array.from({ length: unique.length }, () => [])
  for (let index = 0; index < unique.length; index += 1) {
    const layer = unique[index]
    /* v8 ignore next -- unique was built from layers, so the slot exists */
    if (layer === undefined) continue
    for (const required of layer.requires ?? []) {
      const requiredIndex = indexById.get(required)
      if (requiredIndex === undefined) {
        throw new Error(`activation requires unknown bundle ${JSON.stringify(required)}`)
      }
      if (requiredIndex === index) {
        throw new Error(`activation requires cycle: ${layer.id} -> ${layer.id}`)
      }
      dependents[requiredIndex]?.push(index)
      indegree[index] = (indegree[index] ?? 0) + 1
    }
  }

  const queue = unique
    .map((_, index) => index)
    .filter(index => indegree[index] === 0)
  const ordered: T[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    /* v8 ignore next -- queue indices come from unique */
    const layer = unique[current]
    if (layer !== undefined) ordered.push(layer)
    for (const dependent of dependents[current] ?? []) {
      const degree = indegree[dependent]
      if (degree === undefined) continue
      indegree[dependent] = degree - 1
      if (degree - 1 === 0) {
        queue.push(dependent)
        queue.sort((left, right) => left - right)
      }
    }
  }

  if (ordered.length !== unique.length) {
    const unresolved = unique
      .map((layer, index) => [layer, index] as const)
      .filter(([, index]) => {
        const layer = unique[index]
        return layer !== undefined && !ordered.includes(layer)
      })
      .map(([layer]) => layer.id)
    throw new Error(`activation requires cycle: ${unresolved.join(' -> ')}`)
  }
  return ordered
}

/**
 * Normalize a flat patch list against an optional base entry list so repeated
 * `insert` rows with the same id collapse to one row before the Loader sees
 * them. The input patches are not mutated; the returned list is detached from
 * the input, so callers can hand it directly to the include or retain it for a
 * later reload without aliasing parsed profile layers.
 * @param patches - patch list in the same order `boot()` would apply.
 * @param base - initial entry list the patches patch over; profile roots use
 * the default empty list.
 * @returns the patch list with exact duplicate insert declarations removed.
 * @throws when two insert declarations for one id differ, or when an inserted
 * group child collides with an existing id.
 */
export function dedupeActivationPatches(
  patches: readonly PatchOptions[],
  base: readonly EntryOptions[] = [],
): PatchOptions[] {
  const state: TreeState = {
    root: [],
    byId: new Map(),
    declared: new Map(),
  }
  // Work on detached patch and base objects: the returned list is what callers
  // should hand to the include, and the include mutates inserted rows in place
  // when later id-targeted patches apply.
  const working = structuredClone(patches)
  for (const entry of structuredClone(base)) {
    addInsertRow(state.root, entry, state)
  }

  const output: PatchOptions[] = []
  for (const patch of working) {
    if (!patch.insert) {
      output.push(patch)
      if (typeof patch.id === 'string') {
        const location = state.byId.get(patch.id)
        if (location !== undefined) applyOverride(location.entry, patch)
      }
      continue
    }

    if (patch.id !== undefined) {
      // Patch form `{ id: <group>, insert: [...] }`: the row target must be a
      // group. A missing or non-group target is left unchanged so the normal
      // patch path can still emit its boot-time warning.
      const location = state.byId.get(patch.id)
      const children = location === undefined ? undefined : groupChildren(location.entry)
      if (children === undefined) {
        output.push(patch)
        continue
      }
      const kept: EntryOptions[] = []
      for (const entry of patch.insert) {
        if (addInsertRow(children, entry, state)) kept.push(entry)
      }
      if (kept.length > 0) output.push({ ...patch, insert: kept })
      continue
    }

    const kept: EntryOptions[] = []
    for (const entry of patch.insert) {
      if (addInsertRow(state.root, entry, state)) kept.push(entry)
    }
    if (kept.length > 0) output.push({ ...patch, insert: kept })
  }
  return output
}
