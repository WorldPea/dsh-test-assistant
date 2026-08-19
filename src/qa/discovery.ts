import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DEFAULT_QA_CONFIG, resolveConfigPath } from './config.js'
import type { QaDetectedProject, QaDiscovery } from './types.js'

const MAX_DEPTH = 3
const IGNORED = new Set(['.git', '.idea', '.dsh', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv', '__pycache__'])

export function discoverQaWorkspace(workspace: string, requestedConfig?: string): QaDiscovery {
  const root = resolve(workspace)
  const projects: QaDetectedProject[] = []
  walk(root, root, 0, projects)
  return {
    workspace: root,
    configPath: resolveConfigPath(root, requestedConfig ?? DEFAULT_QA_CONFIG),
    configExists: existsSync(resolveConfigPath(root, requestedConfig ?? DEFAULT_QA_CONFIG)),
    projects: deduplicate(projects),
  }
}

function walk(root: string, current: string, depth: number, output: QaDetectedProject[]): void {
  detectAt(root, current, output)
  if (depth >= MAX_DEPTH) return
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(current, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
    walk(root, join(current, entry.name), depth + 1, output)
  }
}

function detectAt(root: string, dir: string, output: QaDetectedProject[]): void {
  const path = relative(root, dir) || '.'
  if (existsSync(join(dir, 'pom.xml'))) {
    output.push({
      kind: 'java-maven', path, framework: 'maven', testCommand: ['mvn', 'test'],
      coverageFiles: [join(path, 'target/site/jacoco/jacoco.csv')],
    })
  }
  if (existsSync(join(dir, 'build.gradle')) || existsSync(join(dir, 'build.gradle.kts'))) {
    output.push({
      kind: 'java-gradle', path, framework: 'gradle', testCommand: ['./gradlew', 'test'],
      coverageFiles: [join(path, 'build/reports/jacoco/test/jacocoTestReport.csv')],
    })
  }
  if (isPythonProject(dir)) {
    output.push({
      kind: 'python', path, framework: 'pytest', testCommand: ['python', '-m', 'pytest'],
      coverageFiles: [join(path, 'coverage.json')],
    })
  }
  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, any>
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      const scripts = pkg.scripts ?? {}
      const framework = deps.vitest || Object.values(scripts).some(value => String(value).includes('vitest'))
        ? 'vitest'
        : deps.jest || Object.values(scripts).some(value => String(value).includes('jest'))
          ? 'jest'
          : 'npm'
      output.push({
        kind: 'frontend', path, framework,
        testCommand: framework === 'vitest' ? ['npx', 'vitest', 'run'] : framework === 'jest' ? ['npx', 'jest'] : ['npm', 'test'],
        coverageFiles: [join(path, 'coverage/coverage-summary.json')],
      })
    } catch {
      // Invalid package.json is reported when project tests run; discovery stays best-effort.
    }
  }
}

function isPythonProject(dir: string): boolean {
  return ['pyproject.toml', 'pytest.ini', 'requirements.txt', 'setup.py'].some(file => existsSync(join(dir, file)))
}

function deduplicate(values: QaDetectedProject[]): QaDetectedProject[] {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = `${value.kind}:${value.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind))
}
