import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { availableTargets, loadTarget } from './manifest.ts'
import {
  commandOf,
  packageManagerOf,
  repositorySharedOf,
  workspacePackagesOf,
} from './workspace.ts'

let root: string

const write = (path: string, text = ''): void => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const workspace = (path: string, name: string, manifest = false): void => {
  write(`${path}/package.json`, JSON.stringify({ name }))
  if (manifest) write(`${path}/dev-env.ts`, 'export default { services: {} }\n')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dev-env-workspace-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the targets of a repository', () => {
  it('are the workspaces pnpm-workspace.yaml names that hold a dev-env.ts', () => {
    write(
      'pnpm-workspace.yaml',
      "packages:\n  - 'apps/*'\n  - services/**\n  - '!services/legacy'\n"
    )
    workspace('apps/web', '@acme/web', true)
    workspace('apps/docs', '@acme/docs')
    workspace('services/billing/api', '@acme/billing-api', true)
    workspace('services/legacy', '@acme/legacy', true)
    workspace('tools/unlisted', '@acme/unlisted', true)

    expect(availableTargets(root)).toEqual(['api', 'web'])
  })

  it("are the workspaces the root package.json's workspaces name", () => {
    write('package.json', JSON.stringify({ workspaces: ['packages/*'] }))
    workspace('packages/store', 'store', true)
    expect(availableTargets(root)).toEqual(['store'])

    write(
      'package.json',
      JSON.stringify({ workspaces: { packages: ['modules/*'] } })
    )
    workspace('modules/cache', 'cache', true)
    expect(availableTargets(root)).toEqual(['cache'])
  })

  it('are none in a repository without workspaces', () => {
    write('package.json', JSON.stringify({ name: 'single' }))
    write('dev-env.ts', 'export default { services: {} }\n')
    expect(availableTargets(root)).toEqual([])
  })

  it('loads a target from wherever its workspace lives', async () => {
    write('pnpm-workspace.yaml', 'packages:\n  - deep/nested/*\n')
    workspace('deep/nested/store', 'store', true)
    const target = await loadTarget(root, 'store')
    expect(target.directory).toBe(join(root, 'deep/nested/store'))
    expect(target.manifest).toEqual({ services: {} })
  })

  it('loads a manifest that imports TypeScript without extensions, through the paths of its tsconfig.json', async () => {
    write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n')
    write(
      'apps/web/package.json',
      JSON.stringify({ name: 'web', type: 'module' })
    )
    write(
      'apps/web/tsconfig.json',
      '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n'
    )
    write(
      'apps/web/src/services.ts',
      "import { port } from './port'\nexport const services: Record<string, { kind: 'compose'; timeoutMs: number }> = { web: { kind: 'compose', timeoutMs: port } }\n"
    )
    write('apps/web/src/port.ts', 'export const port: number = 5\n')
    write(
      'apps/web/dev-env.ts',
      "import { services } from '@/services'\nexport default { services }\n"
    )
    const target = await loadTarget(root, 'web')
    expect(target.manifest).toEqual({
      services: { web: { kind: 'compose', timeoutMs: 5 } },
    })
  })

  it('loads the manifest of a package that is not "type": "module", through the paths of its tsconfig.json', async () => {
    write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n')
    write('apps/api/package.json', JSON.stringify({ name: 'api' }))
    write(
      'apps/api/tsconfig.json',
      '{ "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }\n'
    )
    write('apps/api/src/port.ts', 'export const port: number = 7\n')
    write(
      'apps/api/dev-env.ts',
      "import { port } from '~/port'\nexport default { services: { api: { kind: 'compose', timeoutMs: port } } }\n"
    )
    const target = await loadTarget(root, 'api')
    expect(target.manifest).toEqual({
      services: { api: { kind: 'compose', timeoutMs: 7 } },
    })
  })

  it('refuses two targets with one name, since the name is all a command gives', () => {
    write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - services/*\n')
    workspace('apps/store', 'store-app', true)
    workspace('services/store', 'store-service', true)
    expect(() => availableTargets(root)).toThrow(
      /apps\/store and services\/store are both named "store"/
    )
  })
})

describe("a repository's package manager", () => {
  it('is the one whose lockfile the repository holds', () => {
    write('pnpm-lock.yaml')
    expect(packageManagerOf(root)).toBe('pnpm')
    rmSync(join(root, 'pnpm-lock.yaml'))
    write('yarn.lock')
    expect(packageManagerOf(root)).toBe('yarn')
    rmSync(join(root, 'yarn.lock'))
    write('package-lock.json', '{}')
    expect(packageManagerOf(root)).toBe('npm')
  })

  it('is the one package.json names, before any lockfile', () => {
    write('package-lock.json', '{}')
    write('package.json', JSON.stringify({ packageManager: 'yarn@4.9.1' }))
    expect(packageManagerOf(root)).toBe('yarn')
  })

  it('is npm when nothing says otherwise', () => {
    expect(packageManagerOf(root)).toBe('npm')
  })

  it('shares its lockfile and workspace file with every integration spec', () => {
    expect(repositorySharedOf('pnpm')).toEqual(
      expect.arrayContaining(['/pnpm-lock.yaml', '/pnpm-workspace.yaml'])
    )
    expect(repositorySharedOf('yarn')).toEqual(
      expect.arrayContaining(['/yarn.lock', '/.yarnrc.yml'])
    )
    expect(repositorySharedOf('npm')).toContain('/package-lock.json')
    expect(repositorySharedOf('npm')).not.toContain('/pnpm-lock.yaml')
  })

  it('runs a tool the repository installed', () => {
    expect(commandOf('pnpm', 'vitest', ['run'])).toEqual([
      'pnpm',
      'exec',
      'vitest',
      'run',
    ])
    expect(commandOf('yarn', 'vitest', ['run'])).toEqual([
      'yarn',
      'vitest',
      'run',
    ])
    expect(commandOf('npm', 'vitest', ['run'])).toEqual([
      'npm',
      'exec',
      '--no',
      '--',
      'vitest',
      'run',
    ])
  })
})

describe("a repository's workspace packages", () => {
  it('are found by the names their package.json gives them', () => {
    write('pnpm-workspace.yaml', 'packages:\n  - libs/*\n  - apps/*\n')
    workspace('libs/ui', '@acme/ui')
    workspace('apps/web', 'web')
    write('libs/no-manifest/README.md')
    expect(workspacePackagesOf(root)).toEqual(
      new Map([
        ['@acme/ui', '/libs/ui/'],
        ['web', '/apps/web/'],
      ])
    )
  })
})
