import { describe, expect, it } from 'vitest'

import { defineManifest, testSettingsOf } from './manifest.ts'

describe('testSettingsOf', () => {
  const manifest = defineManifest({
    services: {},
    testSettings: { flags: '{"stripe":true}' },
  })

  it("starts every test environment with the target's settings", () => {
    expect(testSettingsOf(manifest, { limits: 'raised' })).toEqual({
      flags: '{"stripe":true}',
      limits: 'raised',
    })
  })

  it('lets a spec override one of them', () => {
    expect(testSettingsOf(manifest, { flags: '{}' })).toEqual({ flags: '{}' })
  })

  it('gives a target without any none', () => {
    expect(testSettingsOf(defineManifest({ services: {} }), {})).toEqual({})
  })
})
