import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const officialRepositoryGuard = "github.repository == 'deepseek-harness/deepseek-harness'"

describe('JiMu GitHub workflows', () => {
  it('runs three stable downstream jobs on pull requests and main pushes', () => {
    const workflow = loadYaml('.github/workflows/jimu.yml')
    const jobs = record(workflow.jobs, 'JiMu workflow jobs')
    const events = record(workflow.on, 'JiMu workflow events')

    expect(Object.keys(events).sort()).toEqual(['pull_request', 'push', 'workflow_call'])
    expect(Object.keys(jobs).sort()).toEqual(['desktop', 'security', 'upstream-compat'])
    expect(record(jobs.security, 'security job').name).toBe('security')
    expect(record(jobs['upstream-compat'], 'upstream compatibility job').name).toBe('upstream-compat')
    expect(record(jobs.desktop, 'desktop job').name).toBe('desktop')

    const security = JSON.stringify(record(jobs.security, 'security job').steps)
    expect(security).toContain('node scripts/jimu-audit.mjs --base upstream/master')
    expect(security).toContain('gitleaks dir . --config .gitleaks.toml')
    expect(security).toContain('gitleaks git . --config .gitleaks.toml')
    expect(security).toContain('jimu-gitleaks-negative-control')

    const upstream = JSON.stringify(record(jobs['upstream-compat'], 'upstream compatibility job').steps)
    expect(upstream).toContain('pnpm run build:lib')
    expect(upstream).toContain('pnpm run typecheck:contracts-ready')
    expect(upstream).toContain('pnpm run lint:contracts-ready')
    expect(upstream).toContain('pnpm run test')

    const desktop = JSON.stringify(record(jobs.desktop, 'desktop job').steps)
    expect(record(jobs.desktop, 'desktop job')['runs-on']).toBe('macos-14')
    expect(desktop).toContain('prepare:knowledge-template:release')
    expect(desktop).toContain('pnpm run jimu:test')
    expect(desktop).toContain('@i-yolo/jimu-desktop build')
  })

  it('keeps the real API suite manual and opt-in nightly', () => {
    const workflow = loadYaml('.github/workflows/e2e.yml')
    const events = record(workflow.on, 'real API workflow events')
    const e2e = job(workflow, 'e2e')

    expect(Object.keys(events).sort()).toEqual(['schedule', 'workflow_dispatch'])
    expect(e2e.if).toBe("github.event_name == 'workflow_dispatch' || vars.JIMU_REAL_API_E2E_ENABLED == 'true'")
    expect(JSON.stringify(e2e.steps)).toContain('DEEPSEEK_API_KEY_EXTERNAL')
  })

  it('revalidates the JiMu workflow before a main-only release', () => {
    const workflow = loadYaml('.github/workflows/jimu-release.yml')
    const events = record(workflow.on, 'release workflow events')
    const gates = job(workflow, 'gates')
    const release = job(workflow, 'release')

    expect(Object.keys(events)).toEqual(['workflow_dispatch'])
    expect(gates.uses).toBe('./.github/workflows/jimu.yml')
    expect(release.if).toBe("github.ref == 'refs/heads/main'")
    const steps = JSON.stringify(release.steps)
    expect(steps).toContain('pnpm run build:lib')
    expect(steps).toContain('jimu-release-audit.mjs')
    expect(steps).toContain('test:packaged')
    expect(steps).toContain('gh release create')
  })

  it('lets electron-builder resolve the locked Electron distribution portably', () => {
    const manifest = loadJson('apps/jimu-desktop/package.json')
    const build = record(manifest.build, 'JiMu Desktop build configuration')
    const devDependencies = record(manifest.devDependencies, 'JiMu Desktop development dependencies')

    expect(devDependencies.electron).toBe('43.4.0')
    expect(build.electronDist).toBeUndefined()
  })

  it('pins every remote action used by active JiMu workflows', () => {
    for (const path of [
      '.github/workflows/jimu.yml',
      '.github/workflows/e2e.yml',
      '.github/workflows/codeql.yml',
      '.github/workflows/jimu-release.yml',
    ]) {
      const workflow = loadYaml(path)
      for (const [jobName, value] of Object.entries(record(workflow.jobs, `${path} jobs`))) {
        const current = record(value, `${path} ${jobName}`)
        if (typeof current.uses === 'string') {
          expect(current.uses, `${path} ${jobName}`).toMatch(/^\.\/\.github\/workflows\/[\w.-]+\.yml$/)
        }
        if (!Array.isArray(current.steps)) continue
        for (const step of current.steps) {
          if (!isRecord(step) || typeof step.uses !== 'string') continue
          expect(step.uses, `${path} ${jobName}`).toMatch(/@[0-9a-f]{40}$/)
        }
      }
    }
  })
})

describe('upstream-only workflows', () => {
  it('guards every independent job with the official repository identity', () => {
    const roots: Record<string, string[]> = {
      '.github/workflows/build-exe-for-python-sdk.yml': ['plan'],
      '.github/workflows/ci.yml': [
        'node-24',
        'node-24-coverage',
        'node-24-consumers',
        'node-compat',
        'python-sdk',
        'python-runtime',
        'windows',
        'wine-apt-cache',
        'windows-native',
        'serial-linux',
        'serial-linux-selfhosted',
        'serial-macos',
        'serial-windows',
        'larger-runner-benchmark',
        'consolidated-runner-benchmark',
        'all-checks-passed',
      ],
      '.github/workflows/docs-pages.yml': ['build'],
      '.github/workflows/e2b-e2e.yml': ['e2b'],
      '.github/workflows/expected-filenames.yml': ['expected-filenames'],
      '.github/workflows/issue-lifecycle.yml': ['lifecycle'],
      '.github/workflows/issue-policy.yml': ['policy'],
      '.github/workflows/landlock-run-release.yml': ['matrix'],
      '.github/workflows/landlock-run.yml': ['matrix', 'darwin'],
      '.github/workflows/pi-ai-provider-e2e.yml': ['e2e'],
      '.github/workflows/python-release.yml': ['build'],
      '.github/workflows/release-vendor.yml': ['pack'],
      '.github/workflows/release.yml': ['pack'],
      '.github/workflows/sandbox.yml': ['sandbox-e2e'],
    }

    for (const [path, jobNames] of Object.entries(roots)) {
      const workflow = loadYaml(path)
      for (const jobName of jobNames) {
        const condition = job(workflow, jobName).if
        expect(condition, `${path} ${jobName}`).toEqual(expect.stringContaining(officialRepositoryGuard))
      }
    }
  })
})

describe('JiMu Dependabot policy', () => {
  it('limits monthly grouped updates without grouping major npm or uv releases', () => {
    const config = loadYaml('.github/dependabot.yml')
    const updatesValue = config.updates
    if (!Array.isArray(updatesValue)) throw new TypeError('Dependabot config must define updates')
    const updates = updatesValue as readonly unknown[]

    expect(updates).toHaveLength(3)
    for (const update of updates) {
      const current = record(update, 'Dependabot update')
      expect(record(current.schedule, 'Dependabot schedule').interval).toBe('monthly')
      expect(current['open-pull-requests-limit']).toBe(3)
    }

    for (const ecosystem of ['npm', 'uv']) {
      const update = updates.find(candidate => isRecord(candidate) && candidate['package-ecosystem'] === ecosystem)
      const groups = record(record(update, `${ecosystem} update`).groups, `${ecosystem} groups`)
      const group = record(Object.values(groups)[0], `${ecosystem} non-major group`)
      expect(group['update-types']).toEqual(['minor', 'patch'])
    }
  })
})

function loadYaml(path: string): Record<string, unknown> {
  const parsed: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  return record(parsed, path)
}

function loadJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, path), 'utf8'))
  return record(parsed, path)
}

function job(workflow: Record<string, unknown>, name: string): Record<string, unknown> {
  return record(record(workflow.jobs, 'workflow jobs')[name], `workflow job ${name}`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
