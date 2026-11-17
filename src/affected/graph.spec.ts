import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { graphOf, type Layout, startedBy } from './graph.ts'
import { layoutOf } from './layout.ts'
import { type Selection, selectSpecs } from './select.ts'
import { repositorySharedOf } from '../workspace.ts'

/*
 * A small target on disk: three processes, the second binding the third, a
 * telemetry Worker each runs beside its own code, a context one imports, and
 * a scenario spec that starts the first two.
 */
let root: string
let layout: Layout

const write = (path: string, text: string) => {
  const file = join(root, 'target', path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const worker = (name: string, extra = '') =>
  write(
    `workers/${name}/wrangler.jsonc`,
    `{\n  // The ${name} Worker.\n  "name": "x-${name}",\n  "main": "src/index.ts",\n${extra}\n}\n`
  )

const chosen = (selection: Selection): string[] =>
  selection.kind === 'specs' ? [...selection.specs.keys()] : ['everything']

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'affected-'))
  layout = {
    target: join(root, 'target'),
    repository: root,
    processes: new Map([
      ['door', ['workers/door', 'workers/telemetry']],
      ['intake', ['workers/intake', 'workers/telemetry']],
      ['web', ['workers/web']],
    ]),
    packages: new Map([['@acme/ui', '/libs/ui/']]),
    shared: [
      ...repositorySharedOf('pnpm'),
      'src/db/migrations/**',
      '/tools/**',
    ],
  }
  worker('telemetry')
  write('workers/telemetry/src/index.ts', 'export default {}\n')
  worker('door')
  write(
    'workers/door/src/index.ts',
    "import { limit } from '../../../src/contexts/limits'\nexport default limit\n"
  )
  worker(
    'intake',
    '  "services": [{ "binding": "WEB", "service": "x-web", },],'
  )
  write('workers/intake/src/index.ts', 'export default {}\n')
  worker('web')
  write(
    'workers/web/app/page.tsx',
    "import '@acme/ui/button'\nimport '@repo/unknown'\nexport default 1\n"
  )
  write('src/contexts/limits/index.ts', 'export const limit = 1\n')
  write('src/scenarios/helper.ts', 'export const help = 1\n')
  write(
    'src/scenarios/intake.integration.spec.ts',
    "import { help } from './helper'\nstartTestEnvironment('x', { without: ['web'] })\n"
  )
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('what a spec reaches', () => {
  it('reaches what a Worker it starts imports', () => {
    expect(
      chosen(selectSpecs(graphOf(layout), ['src/contexts/limits/index.ts']))
    ).toEqual(['src/scenarios/intake.integration.spec.ts'])
  })

  it('says which Worker carried the change', () => {
    const selection = selectSpecs(graphOf(layout), [
      'workers/door/src/index.ts',
    ])
    expect(
      selection.kind === 'specs' &&
        selection.specs.get('src/scenarios/intake.integration.spec.ts')
    ).toEqual(['workers/door/src/index.ts, through door'])
  })

  it('follows an import through the paths of the nearest tsconfig.json', () => {
    write(
      'tsconfig.aliases.json',
      '{ "compilerOptions": { "paths": { "@/src/*": ["./src/*"] } } }\n'
    )
    write(
      'workers/intake/tsconfig.json',
      '{ "extends": ["../../tsconfig.aliases.json"] }\n'
    )
    write(
      'workers/intake/src/index.ts',
      "import { on } from '@/src/contexts/flags'\nexport default on\n"
    )
    write('src/contexts/flags/index.ts', 'export const on = true\n')
    const selection = selectSpecs(graphOf(layout), [
      'src/contexts/flags/index.ts',
    ])
    expect(
      selection.kind === 'specs' &&
        selection.specs.get('src/scenarios/intake.integration.spec.ts')
    ).toEqual(['src/contexts/flags/index.ts, through intake'])
  })

  it('reaches every directory a started process names in its sources', () => {
    expect(
      chosen(selectSpecs(graphOf(layout), ['workers/telemetry/src/index.ts']))
    ).toEqual(['src/scenarios/intake.integration.spec.ts'])
  })

  it('reaches what the spec itself imports', () => {
    expect(
      chosen(selectSpecs(graphOf(layout), ['src/scenarios/helper.ts']))
    ).toEqual(['src/scenarios/intake.integration.spec.ts'])
  })

  it("reaches a file the spec imports with a query, such as Vite's ?raw", () => {
    write('samples/send-event.sh', 'curl https://example.com\n')
    write(
      'src/scenarios/samples.integration.spec.ts',
      "import sample from '../../samples/send-event.sh?raw'\nstartTestEnvironment('x', { without: ['door', 'intake', 'web'] })\n"
    )
    expect(
      chosen(selectSpecs(graphOf(layout), ['samples/send-event.sh']))
    ).toEqual(['src/scenarios/samples.integration.spec.ts'])
  })

  it('does not reach a Worker the spec leaves out, its packages, or through a binding to it', () => {
    expect(
      chosen(
        selectSpecs(graphOf(layout), [
          'workers/web/app/page.tsx',
          '/libs/ui/src/button.tsx',
        ])
      )
    ).toEqual([])
  })

  it('does not reach tests, stories and docs inside a Worker', () => {
    expect(
      chosen(
        selectSpecs(graphOf(layout), [
          'workers/intake/src/index.spec.ts',
          'workers/intake/README.md',
        ])
      )
    ).toEqual([])
  })

  it('runs everything for a path the repository or the target shares', () => {
    expect(chosen(selectSpecs(graphOf(layout), ['/pnpm-lock.yaml']))).toEqual([
      'everything',
    ])
    expect(
      chosen(
        selectSpecs(graphOf(layout), [
          '/tools/README.md',
          '/tools/src/ports.spec.ts',
        ])
      )
    ).toEqual([])
    expect(
      chosen(selectSpecs(graphOf(layout), ['src/db/migrations/0001.sql']))
    ).toEqual(['everything'])
  })

  it('reaches a workspace package by the name its package.json gives it, whatever its scope', () => {
    write(
      'src/scenarios/web.integration.spec.ts',
      "startTestEnvironment('x', { without: ['door', 'intake'] })\n"
    )
    const selection = selectSpecs(graphOf(layout), ['/libs/ui/src/button.tsx'])
    expect(
      selection.kind === 'specs' &&
        selection.specs.get('src/scenarios/web.integration.spec.ts')
    ).toEqual(['/libs/ui/src/button.tsx, through web'])
    expect(
      chosen(selectSpecs(graphOf(layout), ['/packages/unknown/index.ts']))
    ).toEqual([])
  })
})

describe('the layout of a target', () => {
  const repository = (files: Readonly<Record<string, string>>) => {
    for (const [path, text] of Object.entries(files)) {
      const file = join(root, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
  }

  it("reads the repository's workspace packages and its package manager's files", () => {
    repository({
      'package.json': JSON.stringify({ workspaces: ['libs/*', 'apps/*'] }),
      'package-lock.json': '{}',
      'libs/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
    })
    const read = layoutOf(join(root, 'apps/web'), root, {
      services: {},
      shared: ['src/db/migrations/**'],
    })
    expect(read.packages).toEqual(
      new Map([
        ['@acme/ui', '/libs/ui/'],
        ['web', '/apps/web/'],
      ])
    )
    expect(read.shared).toEqual(
      expect.arrayContaining([
        'dev-env.ts',
        '/package-lock.json',
        'src/db/migrations/**',
      ])
    )
    expect(read.shared).not.toContain('/pnpm-lock.yaml')
  })
})

describe('a change to the target needs no edit to the selection', () => {
  it('finds a new spec and what it reaches', () => {
    write(
      'src/scenarios/web.integration.spec.ts',
      "startTestEnvironment('x', { without: ['door', 'intake'] })\n"
    )
    const graph = graphOf(layout)
    expect(
      chosen(selectSpecs(graph, ['src/scenarios/web.integration.spec.ts']))
    ).toEqual(['src/scenarios/web.integration.spec.ts'])
    expect(chosen(selectSpecs(graph, ['/libs/ui/src/button.tsx']))).toEqual([
      'src/scenarios/web.integration.spec.ts',
    ])
  })

  it('finds a new process a spec starts', () => {
    worker('exports')
    write(
      'workers/exports/src/index.ts',
      "import { limit } from '../../../src/contexts/limits'\nexport default limit\n"
    )
    write('src/contexts/limits/index.ts', 'export const limit = 2\n')
    layout = {
      ...layout,
      processes: new Map([
        ...layout.processes,
        ['exports', ['workers/exports']],
      ]),
    }
    expect(
      chosen(selectSpecs(graphOf(layout), ['workers/exports/src/index.ts']))
    ).toEqual(['src/scenarios/intake.integration.spec.ts'])
  })
})

describe('reading the Workers a spec starts', () => {
  it('starts every Worker when nothing is left out', () => {
    write(
      'src/scenarios/all.integration.spec.ts',
      "startTestEnvironment('x')\n"
    )
    expect(startedBy(layout, 'src/scenarios/all.integration.spec.ts')).toEqual([
      'door',
      'intake',
      'web',
    ])
  })

  it('refuses a list it cannot read without running the spec', () => {
    write(
      'src/scenarios/odd.integration.spec.ts',
      "const off = ['web']\nstartTestEnvironment('x', { without: off })\n"
    )
    expect(() =>
      startedBy(layout, 'src/scenarios/odd.integration.spec.ts')
    ).toThrow(
      /odd\.integration\.spec\.ts passes startTestEnvironment a `without`/
    )
  })

  it('refuses a Worker dev-env does not start', () => {
    write(
      'src/scenarios/typo.integration.spec.ts',
      "startTestEnvironment('x', { without: ['wbe'] })\n"
    )
    expect(() =>
      startedBy(layout, 'src/scenarios/typo.integration.spec.ts')
    ).toThrow(/leaves out wbe, which its target's manifest does not start/)
  })
})
