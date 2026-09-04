/**
 * `dsh plugin doctor`: it must report healthy profiles, surface activation
 * conflicts from the resolver, and warn about likely identical same-module
 * duplicate instances without modifying the profile.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  loadProfile: vi.fn(),
  composeEntries: vi.fn(),
  dedupeActivationPatches: vi.fn(),
  loadOptionalPatches: vi.fn(),
  resolveProfileBundleLayers: vi.fn(),
}))

vi.mock('../src/profile-boot.ts', () => ({
  homePatchPath: vi.fn(() => '/home/cordis.patch.yml'),
  INSTALL_ANCHOR: '/install/package.json',
}))

import {
  composeEntries,
  dedupeActivationPatches,
  loadOptionalPatches,
  loadProfile,
  resolveProfileBundleLayers,
} from '@deepseek-ai/dsh-app-boot'
import { runPluginDoctor } from '../src/plugin-doctor.ts'

const mocked = {
  loadProfile: vi.mocked(loadProfile),
  composeEntries: vi.mocked(composeEntries),
  dedupeActivationPatches: vi.mocked(dedupeActivationPatches),
  loadOptionalPatches: vi.mocked(loadOptionalPatches),
  resolveProfileBundleLayers: vi.mocked(resolveProfileBundleLayers),
}

const entry = (id: string, name: string, config: Record<string, unknown> = {}): EntryOptions => ({
  id,
  name,
  config,
})

let stdout: ReturnType<typeof vi.spyOn>
let stderr: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
  stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  mocked.loadProfile.mockReturnValue({
    name: 'demo',
    dir: '/profile',
    layers: [],
    patchPath: '/profile/cordis.patch.yml',
    patches: [],
    patchReload: 'live',
  } as never)
  mocked.resolveProfileBundleLayers.mockReturnValue([
    {
      packageName: 'base',
      packageDir: '/base',
      patchPath: '/base/cordis.patch.yml',
      patches: [],
    },
  ] as never)
  mocked.loadOptionalPatches.mockReturnValue([])
  mocked.dedupeActivationPatches.mockImplementation(patches => patches as never)
  mocked.composeEntries.mockReturnValue([])
})

describe('runPluginDoctor', () => {
  it('reports a healthy profile', () => {
    expect(runPluginDoctor('demo')).toBe(0)
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('is healthy'))
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('issue'))
  })

  it('reports an activation conflict as a fatal issue', () => {
    mocked.dedupeActivationPatches.mockImplementation(() => {
      throw new Error('activation conflict: duplicate loader entry id "embedding"')
    })
    expect(runPluginDoctor('demo')).toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('activation conflict'))
  })

  it('warns when one module is mounted under two ids with identical config', () => {
    mocked.composeEntries.mockReturnValue([
      entry('embedding-a', 'dsh-embedding', { model: 'x' }),
      entry('embedding-b', 'dsh-embedding', { model: 'x' }),
    ])
    expect(runPluginDoctor('demo')).toBe(0)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('identical config'))
  })
})
