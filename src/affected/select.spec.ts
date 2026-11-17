import { describe, expect, it } from 'vitest'

import { forPullRequest, matches } from './select.ts'

describe('a glob', () => {
  it('crosses directories with ** and stays in one with *', () => {
    expect(matches('workers/door/**', 'workers/door/src/limits.ts')).toBe(true)
    expect(matches('**/wrangler.jsonc', 'workers/door/wrangler.jsonc')).toBe(
      true
    )
    expect(matches('src/*.ts', 'src/db/schema.ts')).toBe(false)
    expect(matches('workers/door/**', 'workers/doorway/index.ts')).toBe(false)
  })

  it('reads a dot as a dot', () => {
    expect(matches('dev-env.ts', 'dev-envxts')).toBe(false)
  })
})

describe("a pull request's specs", () => {
  const reached = {
    kind: 'specs',
    specs: new Map([['src/door.integration.spec.ts', ['src/door.ts']]]),
  } as const

  it('adds the specs it always runs to those its changes reach', () => {
    expect(
      forPullRequest(reached, [], {
        always: ['src/product.integration.spec.ts'],
      })
    ).toEqual(
      new Map([
        ['src/door.integration.spec.ts', ['src/door.ts']],
        ['src/product.integration.spec.ts', ['every pull request runs it']],
      ])
    )
  })

  it('leaves a spec only the full suite runs out, even when its changes reach it or every spec is affected', () => {
    const beforeRelease = ['src/door.integration.spec.ts']
    expect(forPullRequest(reached, [], { beforeRelease })).toEqual(new Map())
    expect([
      ...forPullRequest(
        { kind: 'everything', because: ['dev-env.ts is shared'] },
        ['src/door.integration.spec.ts', 'src/intake.integration.spec.ts'],
        { beforeRelease }
      ).keys(),
    ]).toEqual(['src/intake.integration.spec.ts'])
  })
})
