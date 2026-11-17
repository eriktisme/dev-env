import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isAbandonedProject } from './abandoned.ts'
import { environmentIdOf } from './checkout.ts'

const ROOT = '/work/worktrees/gone'
const ID = environmentIdOf(ROOT)
const DIRECTORY = join(ROOT, 'apps', 'store')
const gone = () => false

describe('a project left by a deleted checkout', () => {
  it('is one dev-env made for that checkout, in dev or any test lane', () => {
    for (const project of [
      `gone-${ID}-store`,
      `gone-${ID}-store-test`,
      `gone-${ID}-store-test-3`,
    ])
      expect(isAbandonedProject(project, DIRECTORY, gone)).toBe(true)
  })

  it('is one whose target lived at any depth of the checkout', () => {
    for (const directory of [
      join(ROOT, 'store'),
      join(ROOT, 'services', 'billing', 'store'),
    ])
      expect(isAbandonedProject(`gone-${ID}-store`, directory, gone)).toBe(true)
  })

  it('is never a checkout that still exists', () => {
    expect(isAbandonedProject(`gone-${ID}-store`, DIRECTORY, () => true)).toBe(
      false
    )
  })

  it('is never a project whose name another checkout or another tool chose', () => {
    for (const project of [
      `gone-00000000-store`,
      `gone-${ID}-other`,
      `gone-${ID}-store-extra`,
      `other-${ID}-store`,
      `dev-env-shared-${ID.replace(/./, '0')}-store`,
      'crm-1553-ba0c117b',
    ])
      expect(isAbandonedProject(project, DIRECTORY, gone)).toBe(false)
    expect(
      isAbandonedProject(
        `gone-${ID}-store`,
        join('/elsewhere', 'apps', 'store'),
        gone
      )
    ).toBe(false)
  })
})
