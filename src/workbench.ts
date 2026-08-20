import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { discoverQaWorkspace } from './qa/discovery.js'
import { DEFAULT_QA_CONFIG, resolveConfigPath, validateQaConfig } from './qa/config.js'
import { readRunReport } from './qa/report.js'
import type {
  QaBrowserAction, QaCase, QaConfig, QaDetectedProject, QaDiscovery, QaEnvironment,
  QaRunReport,
} from './qa/types.js'

export interface WorkbenchLoginInput {
  enabled?: boolean
  loginUrl?: string
  usernameSelector?: string
  usernameEnv?: string
  passwordSelector?: string
  passwordEnv?: string
  submitSelector?: string
  successSelector?: string
}

export interface WorkbenchDatabaseInput {
  enabled?: boolean
  hostEnv?: string
  port?: number
  databaseEnv?: string
  userEnv?: string
  passwordEnv?: string
}

export interface WorkbenchLogInput {
  enabled?: boolean
  url?: string
  tokenEnv?: string
}

export interface WorkbenchScaffoldInput {
  environment?: string
  baseUrl?: string
  includeProjects?: string[]
  browser?: boolean
  login?: WorkbenchLoginInput
  database?: WorkbenchDatabaseInput
  logs?: WorkbenchLogInput
}

export interface WorkbenchSnapshot {
  workspace: string
  discovery: QaDiscovery
  configPath: string
  configExists: boolean
  config?: QaConfig
  validation?: {
    valid: boolean
    errors: string[]
    warnings: string[]
    missingEnvironmentVariables: string[]
  }
  latestReport?: QaRunReport
}

export function readWorkbenchSnapshot(workspace: string): WorkbenchSnapshot {
  const discovery = discoverQaWorkspace(workspace)
  const configPath = resolveConfigPath(workspace)
  if (!existsSync(configPath)) return { workspace, discovery, configPath, configExists: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (cause) {
    return {
      workspace,
      discovery,
      configPath,
      configExists: true,
      validation: {
        valid: false,
        errors: [`QA config is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`],
        warnings: [],
        missingEnvironmentVariables: [],
      },
      ...latestReport(workspace),
    }
  }
  const validation = validateQaConfig(parsed, configPath)
  return {
    workspace,
    discovery,
    configPath,
    configExists: true,
    ...(validation.config === undefined ? {} : { config: validation.config }),
    validation: {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      missingEnvironmentVariables: validation.missingEnvironmentVariables,
    },
    ...latestReport(workspace, validation.config?.artifactsDir),
  }
}

export function createWorkbenchConfig(discovery: QaDiscovery, input: WorkbenchScaffoldInput): QaConfig {
  const environmentName = nonEmpty(input.environment) ?? 'test'
  const selected = selectProjects(discovery.projects, input.includeProjects)
  const environment: QaEnvironment = {}
  const baseUrl = nonEmpty(input.baseUrl)
  if (baseUrl !== undefined) environment.baseUrl = baseUrl

  const login = input.login
  if (input.browser === true || login?.enabled === true) {
    const setup: QaBrowserAction[] = []
    if (login?.enabled === true) {
      const loginUrl = nonEmpty(login.loginUrl) ?? '/login'
      setup.push({ action: 'goto', url: loginUrl })
      addFill(setup, login.usernameSelector, login.usernameEnv)
      addFill(setup, login.passwordSelector, login.passwordEnv)
      const submit = nonEmpty(login.submitSelector)
      if (submit !== undefined) setup.push({ action: 'click', selector: submit })
      const success = nonEmpty(login.successSelector)
      if (success !== undefined) setup.push({ action: 'waitFor', selector: success })
    }
    environment.browser = { channel: 'chrome', headless: true, setup }
  }

  const database = input.database
  if (database?.enabled === true) {
    environment.database = {
      type: 'mysql',
      hostEnv: nonEmpty(database.hostEnv) ?? 'QA_DB_HOST',
      port: database.port ?? 3306,
      databaseEnv: nonEmpty(database.databaseEnv) ?? 'QA_DB_NAME',
      userEnv: nonEmpty(database.userEnv) ?? 'QA_DB_USER',
      passwordEnv: nonEmpty(database.passwordEnv) ?? 'QA_DB_PASSWORD',
      maxRows: 100,
    }
  }

  const logs = input.logs
  const logUrl = nonEmpty(logs?.url)
  if (logs?.enabled === true && logUrl !== undefined) {
    const tokenEnv = nonEmpty(logs.tokenEnv) ?? 'QA_LOG_TOKEN'
    environment.logs = {
      application: {
        type: 'http',
        url: logUrl,
        method: 'POST',
        headers: { Authorization: `Bearer \${env:${tokenEnv}}` },
        queryField: 'query',
      },
    }
  }

  const suites: QaConfig['suites'] = []
  const projectCases = selected.map(projectCase)
  if (projectCases.length > 0) suites.push({ id: 'project-regression', name: '项目测试回归', cases: projectCases })
  if (environment.browser !== undefined && baseUrl !== undefined) {
    const steps: QaCase['steps'] = [{ id: 'open-page', type: 'ui', action: 'goto', url: '/' }]
    const success = nonEmpty(login?.successSelector)
    if (success !== undefined) steps.push({ id: 'page-ready', type: 'ui', action: 'waitFor', selector: success })
    steps.push({ id: 'page-evidence', type: 'ui', action: 'screenshot', name: 'workbench-smoke' })
    suites.push({
      id: 'browser-smoke',
      name: '页面冒烟测试',
      cases: [{ id: 'browser-login-smoke', name: '登录并打开目标页面', risk: 'read', tags: ['smoke', 'ui'], steps }],
    })
  }
  if (suites.length === 0) {
    suites.push({
      id: 'setup-required',
      name: '待配置测试',
      cases: [{
        id: 'setup-required',
        name: '补充项目测试或页面环境',
        risk: 'read',
        steps: [{ id: 'placeholder', type: 'project.test', framework: 'script', command: ['node', '-e', 'console.log("QA workbench configured")'] }],
      }],
    })
  }
  return {
    version: 1,
    defaultEnvironment: environmentName,
    artifactsDir: '.dsh/qa-runs',
    allowDestructive: false,
    requirements: [],
    environments: { [environmentName]: environment },
    suites,
  }
}

export function saveWorkbenchConfig(workspace: string, config: unknown): WorkbenchSnapshot {
  const configPath = resolveConfigPath(workspace, DEFAULT_QA_CONFIG)
  const validation = validateQaConfig(config, configPath)
  if (!validation.valid || validation.config === undefined) {
    throw new Error(`QA config validation failed:\n${validation.errors.map(error => `- ${error}`).join('\n')}`)
  }
  const directory = dirname(configPath)
  assertWorkspaceDirectory(workspace, directory)
  const temp = join(directory, `.qa.e2e.${process.pid}.${Date.now()}.tmp`)
  if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.bak`)
  writeFileSync(temp, JSON.stringify(validation.config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, configPath)
  return readWorkbenchSnapshot(workspace)
}

function selectProjects(projects: QaDetectedProject[], requested?: string[]): QaDetectedProject[] {
  if (requested !== undefined && requested.length > 0) {
    const selected = new Set(requested)
    return projects.filter(project => selected.has(projectKey(project)))
  }
  const result: QaDetectedProject[] = []
  const sorted = [...projects].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
  for (const project of sorted) {
    if (result.some(existing => existing.kind === project.kind && (existing.path === '.' || project.path.startsWith(`${existing.path}/`)))) continue
    result.push(project)
  }
  return result
}

function projectCase(project: QaDetectedProject): QaCase {
  const framework = ['maven', 'gradle', 'pytest', 'vitest', 'jest'].includes(project.framework)
    ? project.framework as 'maven' | 'gradle' | 'pytest' | 'vitest' | 'jest'
    : 'script'
  return {
    id: `project-${safeId(project.kind)}-${safeId(project.path)}`,
    name: `${project.path} ${project.framework} 测试`,
    risk: 'read',
    tags: ['project-test', project.kind],
    steps: [{
      id: 'run-tests',
      type: 'project.test',
      project: project.path,
      framework,
      ...(framework === 'script' ? { command: project.testCommand } : {}),
    }],
  }
}

function projectKey(project: QaDetectedProject): string {
  return `${project.kind}:${project.path}`
}

function safeId(value: string): string {
  return value === '.' ? 'root' : value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '')
}

function addFill(steps: QaBrowserAction[], selectorValue?: string, envValue?: string): void {
  const selector = nonEmpty(selectorValue)
  const env = nonEmpty(envValue)
  if (selector !== undefined && env !== undefined) steps.push({ action: 'fill', selector, value: `\${env:${env}}` })
}

function latestReport(workspace: string, artifactsDir?: string): Pick<WorkbenchSnapshot, 'latestReport'> {
  try {
    return { latestReport: readRunReport(workspace, undefined, artifactsDir) }
  } catch {
    return {}
  }
}

function assertWorkspaceDirectory(workspace: string, directory: string): void {
  const root = realpathSync(workspace)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink()) throw new Error('QA config directory must not be a symbolic link')
  const actual = realpathSync(directory)
  const rel = relative(root, actual)
  if (rel.startsWith('..') || resolve(root, rel) !== actual) throw new Error('QA config directory escapes workspace')
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

export const workbenchInternals = { projectKey, selectProjects }
