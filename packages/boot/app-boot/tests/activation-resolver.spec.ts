/**
 * Minimal activation resolver: duplicate loader entry ids contributed by
 * multiple `insert` declarations collapse when identical and fail loud when
 * they differ, before the Loader reports its low-level duplicate error.
 */

import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  composeEntries,
  dedupeActivationPatches,
} from '../src/index.ts'

const embedding = (config: Record<string, unknown> = {}): EntryOptions => ({
  id: 'embedding',
  name: 'dsh-embedding',
  config,
})

describe('dedupeActivationPatches', () => {
  it('drops an exact duplicate root insert declaration', () => {
    const first = { insert: [embedding({ model: 'x' })] }
    const second = { insert: [embedding({ model: 'x' })] }
    const result = dedupeActivationPatches([first, second])
    expect(result).toEqual([first])
  })

  it('keeps a later id-targeted override after an insert', () => {
    const result = dedupeActivationPatches([
      { insert: [embedding({ model: 'x' })] },
      { id: 'embedding', config: { model: 'y' } },
    ])
    expect(result).toEqual([
      { insert: [embedding({ model: 'x' })] },
      { id: 'embedding', config: { model: 'y' } },
    ])
  })

  it('still merges an original declaration that repeats after an override', () => {
    const result = dedupeActivationPatches([
      { insert: [embedding({ model: 'x' })] },
      { id: 'embedding', config: { model: 'y' } },
      { insert: [embedding({ model: 'x' })] },
    ])
    expect(result).toEqual([
      { insert: [embedding({ model: 'x' })] },
      { id: 'embedding', config: { model: 'y' } },
    ])
  })

  it('throws when duplicate insert declarations differ', () => {
    expect(() => dedupeActivationPatches([
      { insert: [embedding({ model: 'x' })] },
      { insert: [embedding({ model: 'y' })] },
    ])).toThrow(/activation conflict: duplicate loader entry id "embedding"/)
  })

  it('throws when duplicate inserts use the same id but different names', () => {
    expect(() => dedupeActivationPatches([
      { insert: [embedding()] },
      { insert: [{ id: 'embedding', name: 'other-embedding' }] },
    ])).toThrow(/activation conflict/)
  })

  it('drops duplicate children inserted into the same group', () => {
    const result = dedupeActivationPatches([
      { insert: [{ id: 'g', name: 'cordis:group', group: true, config: [] }] },
      { id: 'g', insert: [{ id: 'child', name: 'pkg-child' }] },
      { id: 'g', insert: [{ id: 'child', name: 'pkg-child' }] },
    ])
    expect(result).toEqual([
      { insert: [{ id: 'g', name: 'cordis:group', group: true, config: [] }] },
      { id: 'g', insert: [{ id: 'child', name: 'pkg-child' }] },
    ])
  })

  it('throws when group children with the same id differ', () => {
    expect(() => dedupeActivationPatches([
      { insert: [{ id: 'g', name: 'cordis:group', group: true, config: [] }] },
      { id: 'g', insert: [{ id: 'child', name: 'pkg-child', config: { v: 1 } }] },
      { id: 'g', insert: [{ id: 'child', name: 'pkg-child', config: { v: 2 } }] },
    ])).toThrow(/activation conflict/)
  })

  it('detects duplicate inserts against a non-empty base list', () => {
    const base = [embedding()]
    expect(() => dedupeActivationPatches([{ insert: [embedding({ model: 'x' })] }], base))
      .toThrow(/activation conflict/)
    expect(dedupeActivationPatches([{ insert: [embedding()] }], base)).toEqual([])
  })
})

describe('composeEntries integration', () => {
  it('composes duplicate identical inserts into one loader row', () => {
    const entries = composeEntries([
      [{ insert: [embedding({ model: 'x' })] }],
      [{ insert: [embedding({ model: 'x' })] }],
    ])
    expect(entries).toEqual([embedding({ model: 'x' })])
  })

  it('lets a later id-targeted layer override a shared row', () => {
    const entries = composeEntries([
      [{ insert: [embedding({ model: 'x' })] }],
      [{ id: 'embedding', config: { model: 'y' } }],
    ])
    expect(entries).toEqual([embedding({ model: 'y' })])
  })
})
