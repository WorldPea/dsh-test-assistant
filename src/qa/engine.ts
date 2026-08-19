import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { discoverQaWorkspace } from './discovery.js'
import { loadQaConfig, resolveConfigPath } from './config.js'
import { createRunReport, writeLatestPointer, writeRunReport } from './report.js'
import {
  errorMessage, getPath, readCodeCoverage, redact, resolveTemplate, runChecks,
  runProcess, safeWorkspacePath, type TemplateContext,
} from './runtime.js'
import type {
  JsonValue, QaApiStep, QaBrowserAction, QaCase, QaCaseResult, QaCheckResult,
  QaCodeCoverage, QaConfig, QaDbStep, QaEnvironment, QaIssue, QaIssueSeverity,
  QaLogStep, QaProjectTestStep, QaRunOptions, QaRunReport, QaServiceStartStep,
  QaStatus, QaStep, QaStepResult, QaUiStep,
} from './types.js'

interface StepExecution {
  output: JsonValue
  checks?: QaCheckResult[]
  evidence?: string[]
  passed?: boolean
  blocked?: boolean
}

interface RunningService {
  name: string
  child: ReturnType<typeof spawn>
  stdout: string
  stderr: string
}

export async function runQaPlan(options: QaRunOptions): Promise<QaRunReport> {
  const startedAt = new Date().toISOString()
  const runId = createRunId()
  const config = loadQaConfig(options.workspace, options.configPath)
  const environmentName = options.environment ?? config.defaultEnvironment ?? Object.keys(config.environments)[0]
  if (environmentName === undefined) throw new Error('QA config has no environment')
  const environment = config.environments[environmentName]
  if (environment === undefined) throw new Error(`QA environment "${environmentName}" does not exist`)
  const selectedCases = selectCases(config, options)
  if (selectedCases.length === 0) throw new Error('QA selection matched no cases')
  const artifactsBase = safeWorkspacePath(options.workspace, config.artifactsDir ?? '.dsh/qa-runs')
  const artifactsRoot = join(artifactsBase, runId)
  const evidenceRoot = join(artifactsRoot, 'evidence')
  mkdirSync(evidenceRoot, { recursive: true })

  const template: TemplateContext = {
    workspace: resolve(options.workspace),
    runId,
    environment,
    steps: new Map(),
    secretValues: new Set(),
  }
  const services = new ServiceManager(template, options.signal)
  const browser = new BrowserManager(template, evidenceRoot, options.signal)
  const cases: QaCaseResult[] = []
  const issues: QaIssue[] = []
  const codeCoverage: QaCodeCoverage[] = []
  const caseStatuses = new Map<string, QaStatus>()
  let issueSequence = 0

  try {
    for (const testCase of selectedCases) {
      const result = await runCase({
        testCase, options, config, environment, template, services, browser,
        evidenceRoot, caseStatuses, codeCoverage,
      })
      cases.push(result)
      caseStatuses.set(testCase.id, result.status)
      for (const step of result.steps) {
        if (step.status !== 'failed' && step.status !== 'blocked') continue
        issueSequence += 1
        issues.push(issueFromStep(issueSequence, testCase, step))
      }
    }
  } finally {
    await browser.close()
    await services.close()
  }

  const finishedAt = new Date().toISOString()
  const report = createRunReport({
    runId,
    workspace: resolve(options.workspace),
    environment: environmentName,
    startedAt,
    finishedAt,
    selectedCases,
    allRequirements: (config.requirements ?? []).map(requirement => requirement.id),
    cases,
    codeCoverage,
    issues,
    artifactsRoot,
  })
  maskReport(report, template.secretValues)
  writeRunReport(report)
  writeLatestPointer(report, artifactsBase)
  return report
}

async function runCase(context: {
  testCase: QaCase
  options: QaRunOptions
  config: QaConfig
  environment: QaEnvironment
  template: TemplateContext
  services: ServiceManager
  browser: BrowserManager
  evidenceRoot: string
  caseStatuses: Map<string, QaStatus>
  codeCoverage: QaCodeCoverage[]
}): Promise<QaCaseResult> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const risk = context.testCase.risk ?? 'read'
  const blockedReason = caseBlockReason(context.testCase, context.options, context.config, context.caseStatuses)
  if (blockedReason !== undefined) {
    return {
      id: context.testCase.id,
      name: context.testCase.name,
      risk,
      requirements: context.testCase.requirements ?? [],
      status: 'blocked',
      startedAt,
      durationMs: Date.now() - started,
      steps: [{
        id: 'preflight', name: '用例前置校验', type: 'project.test', status: 'blocked',
        startedAt, durationMs: 0, checks: [], error: blockedReason,
      }],
    }
  }

  const steps: QaStepResult[] = []
  let stop = false
  for (const step of context.testCase.steps) {
    if (stop) {
      steps.push(skippedStep(step, '前置步骤失败，后续步骤未执行'))
      continue
    }
    const result = await runStep(step, context)
    steps.push(result)
    if ((result.status === 'failed' || result.status === 'blocked')
      && !step.continueOnFailure && !context.testCase.continueOnFailure) stop = true
  }
  return {
    id: context.testCase.id,
    name: context.testCase.name,
    risk,
    requirements: context.testCase.requirements ?? [],
    status: aggregateCaseStatus(steps),
    startedAt,
    durationMs: Date.now() - started,
    steps,
  }
}

async function runStep(step: QaStep, context: Parameters<typeof runCase>[0]): Promise<QaStepResult> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  try {
    const resolved = resolveTemplate(step, context.template)
    let execution: StepExecution
    switch (resolved.type) {
      case 'service.start': execution = await context.services.start(resolved); break
      case 'project.test': execution = await runProjectTest(resolved, context); break
      case 'ui': execution = await context.browser.execute(resolved); break
      case 'api': execution = await runApi(resolved, context); break
      case 'db.query': execution = await runDb(resolved, context); break
      case 'log.query': execution = await runLog(resolved, context); break
    }
    context.template.steps.set(step.id, execution.output)
    const checks = execution.checks ?? []
    const passed = execution.passed ?? checks.every(check => check.passed)
    return {
      id: step.id,
      name: step.name ?? step.id,
      type: step.type,
      status: execution.blocked ? 'blocked' : passed ? 'passed' : 'failed',
      startedAt,
      durationMs: Date.now() - started,
      output: execution.output,
      checks,
      ...(execution.evidence !== undefined ? { evidence: execution.evidence } : {}),
    }
  } catch (cause) {
    const error = redact(errorMessage(cause), context.template.secretValues)
    let evidence: string[] | undefined
    if (step.type === 'ui') evidence = await context.browser.captureFailure(context.testCase.id, step.id)
    return {
      id: step.id,
      name: step.name ?? step.id,
      type: step.type,
      status: isBlockedError(error) ? 'blocked' : 'failed',
      startedAt,
      durationMs: Date.now() - started,
      checks: [],
      error,
      ...(evidence !== undefined ? { evidence } : {}),
    }
  }
}

async function runProjectTest(step: QaProjectTestStep, context: Parameters<typeof runCase>[0]): Promise<StepExecution> {
  const project = step.project ?? '.'
  const cwd = safeWorkspacePath(context.options.workspace, project)
  const detected = discoverQaWorkspace(cwd).projects.find(candidate => candidate.path === '.')
  const framework = step.framework === undefined || step.framework === 'auto'
    ? detected?.framework ?? 'script'
    : step.framework
  const command = step.command ?? defaultTestCommand(framework, cwd, step.path)
  if (command.length === 0) throw new Error('BLOCKED: project.test requires a command for unknown project type')
  const result = await runProcess({
    command,
    cwd,
    timeoutMs: step.timeoutMs ?? 10 * 60_000,
    signal: context.options.signal,
  })
  const coverage = readCodeCoverage(context.options.workspace, project, framework, step.coverageFile)
  if (coverage !== undefined) context.codeCoverage.push(coverage)
  return {
    output: JSON.parse(JSON.stringify({
      framework,
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdout: redact(result.stdout, context.template.secretValues),
      stderr: redact(result.stderr, context.template.secretValues),
      ...(coverage !== undefined ? { coverage } : {}),
    })) as JsonValue,
    passed: result.exitCode === 0 && !result.timedOut,
  }
}

async function runApi(step: QaApiStep, context: Parameters<typeof runCase>[0]): Promise<StepExecution> {
  const url = absoluteUrl(step.url, context.environment.baseUrl)
  const headers = { ...(step.headers ?? {}) }
  if (step.useBrowserSession === true && !hasHeader(headers, 'cookie')) {
    const cookie = await context.browser.cookieHeader(url)
    if (cookie !== '') headers.cookie = cookie
  }
  const init: RequestInit = { method: step.method ?? 'GET', headers, signal: timeoutSignal(step.timeoutMs, context.options.signal) }
  if (step.body !== undefined) {
    if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json'
    init.body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body)
  }
  const response = await fetch(url, init)
  const body = (await response.text()).slice(0, 200_000)
  let json: JsonValue | null = null
  try { json = JSON.parse(body) as JsonValue } catch { /* text response */ }
  const output: JsonValue = {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: redact(body, context.template.secretValues),
    ...(json !== null ? { json } : {}),
  }
  const checks = step.checks ?? [{ path: 'status', operator: 'gte', expected: 200 }, { path: 'status', operator: 'lt', expected: 300 }]
  return { output, checks: runChecks(output, checks) }
}

async function runDb(step: QaDbStep, context: Parameters<typeof runCase>[0]): Promise<StepExecution> {
  assertReadOnlySql(step.sql)
  const db = context.environment.database
  if (db === undefined) throw new Error('BLOCKED: database is not configured for this environment')
  const required = (name: string): string => {
    const value = process.env[name]
    if (value === undefined) throw new Error(`BLOCKED: required database environment variable "${name}" is missing`)
    if (/PASSWORD|TOKEN|SECRET|KEY/i.test(name) && value !== '') context.template.secretValues.add(value)
    return value
  }
  const mysql = await import('mysql2/promise')
  const connection = await mysql.createConnection({
    host: required(db.hostEnv),
    port: db.port ?? 3306,
    database: required(db.databaseEnv),
    user: required(db.userEnv),
    password: required(db.passwordEnv),
    connectTimeout: db.connectTimeoutMs ?? step.timeoutMs ?? 10_000,
    ssl: db.ssl ? {} : undefined,
    multipleStatements: false,
  })
  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY')
    const [rows] = await connection.execute(step.sql, step.params ?? [])
    const values = Array.isArray(rows) ? rows.slice(0, db.maxRows ?? 100) : rows
    const output: JsonValue = {
      rowCount: Array.isArray(rows) ? rows.length : 0,
      rows: JSON.parse(JSON.stringify(values)) as JsonValue,
      truncated: Array.isArray(rows) && rows.length > (db.maxRows ?? 100),
    }
    return { output, checks: runChecks(output, step.checks) }
  } finally {
    await connection.end()
  }
}

async function runLog(step: QaLogStep, context: Parameters<typeof runCase>[0]): Promise<StepExecution> {
  const source = context.environment.logs?.[step.source]
  if (source === undefined) throw new Error(`BLOCKED: log source "${step.source}" is not configured`)
  if (source.type === 'file') {
    const path = safeWorkspacePath(context.options.workspace, source.path)
    if (!existsSync(path)) throw new Error(`BLOCKED: log file does not exist: ${path}`)
    const max = source.maxBytes ?? 200_000
    const content = readFileSync(path)
    const tail = content.subarray(Math.max(0, content.length - max)).toString('utf8')
    const body = step.query === undefined
      ? tail
      : tail.split(/\r?\n/).filter(line => line.includes(step.query!)).join('\n')
    const output: JsonValue = { body: redact(body, context.template.secretValues), bytes: content.length }
    const checks = step.checks ?? (step.query === undefined ? [] : [{ path: 'body', operator: 'contains', expected: step.query }])
    return { output, checks: runChecks(output, checks) }
  }
  const headers = { ...(source.headers ?? {}) }
  const method = source.method ?? 'POST'
  const bodyObject = { ...(source.baseBody ?? {}), ...(step.body ?? {}) }
  if (step.query !== undefined) bodyObject[source.queryField ?? 'query'] = step.query
  if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json'
  const response = await fetch(source.url, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(bodyObject),
    signal: timeoutSignal(step.timeoutMs ?? source.timeoutMs, context.options.signal),
  })
  const body = (await response.text()).slice(0, 200_000)
  let json: JsonValue | undefined
  try { json = JSON.parse(body) as JsonValue } catch { /* text log response */ }
  const output: JsonValue = { status: response.status, body: redact(body, context.template.secretValues), ...(json !== undefined ? { json } : {}) }
  const checks = step.checks ?? [{ path: 'status', operator: 'gte', expected: 200 }, { path: 'status', operator: 'lt', expected: 300 }]
  return { output, checks: runChecks(output, checks) }
}

class BrowserManager {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private page: Page | undefined
  private setupComplete = false

  constructor(
    private readonly template: TemplateContext,
    private readonly evidenceRoot: string,
    private readonly signal?: AbortSignal,
  ) {}

  async execute(step: QaUiStep): Promise<StepExecution> {
    const page = await this.ensurePage()
    const output = await executeBrowserAction(page, step, this.template.environment.baseUrl, this.evidenceRoot)
    return output
  }

  async cookieHeader(url: string): Promise<string> {
    await this.ensurePage()
    const cookies = await this.context!.cookies(url)
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  }

  async captureFailure(caseId: string, stepId: string): Promise<string[]> {
    if (this.page === undefined) return []
    const path = join(this.evidenceRoot, `${safeName(caseId)}-${safeName(stepId)}-failure.png`)
    try {
      await this.page.screenshot({ path, fullPage: true })
      return [path]
    } catch {
      return []
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined)
    await this.browser?.close().catch(() => undefined)
    this.page = undefined
    this.context = undefined
    this.browser = undefined
  }

  private async ensurePage(): Promise<Page> {
    if (this.page !== undefined) return this.page
    const config = this.template.environment.browser
    if (config === undefined) throw new Error('BLOCKED: browser is not configured for this environment')
    const { chromium } = await import('playwright-core')
    this.browser = await chromium.launch({
      headless: config.headless ?? true,
      ...(config.executablePath !== undefined ? { executablePath: config.executablePath } : { channel: config.channel ?? 'chrome' }),
    })
    const storageState = config.storageStatePath === undefined
      ? undefined
      : safeWorkspacePath(this.template.workspace, config.storageStatePath)
    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: config.ignoreHTTPSErrors ?? false,
      viewport: config.viewport ?? { width: 1440, height: 900 },
      ...(storageState !== undefined && existsSync(storageState) ? { storageState } : {}),
    })
    this.page = await this.context.newPage()
    this.signal?.addEventListener('abort', () => { void this.close() }, { once: true })
    if (!this.setupComplete) {
      for (const raw of config.setup ?? []) {
        const action = resolveTemplate(raw, this.template)
        const result = await executeBrowserAction(this.page, action, this.template.environment.baseUrl, this.evidenceRoot)
        if (result.passed === false || result.checks?.some(check => !check.passed)) {
          throw new Error(`browser setup action "${action.action}" failed`)
        }
      }
      this.setupComplete = true
    }
    return this.page
  }
}

async function executeBrowserAction(
  page: Page,
  step: QaBrowserAction,
  baseUrl: string | undefined,
  evidenceRoot: string,
): Promise<StepExecution> {
  const timeout = step.timeoutMs ?? 30_000
  switch (step.action) {
    case 'goto': {
      if (step.url === undefined) throw new Error('ui.goto requires url')
      const response = await page.goto(absoluteUrl(step.url, baseUrl), { waitUntil: 'domcontentloaded', timeout })
      return { output: { url: page.url(), title: await page.title(), status: response?.status() ?? 0 }, passed: response?.ok() ?? true }
    }
    case 'fill':
      if (step.selector === undefined || step.value === undefined) throw new Error('ui.fill requires selector and value')
      await page.locator(step.selector).fill(step.value, { timeout })
      return { output: { selector: step.selector, filled: true } }
    case 'click':
      if (step.selector === undefined) throw new Error('ui.click requires selector')
      await page.locator(step.selector).click({ timeout })
      return { output: { selector: step.selector, clicked: true, url: page.url() } }
    case 'press':
      if (step.selector === undefined || step.key === undefined) throw new Error('ui.press requires selector and key')
      await page.locator(step.selector).press(step.key, { timeout })
      return { output: { selector: step.selector, key: step.key, pressed: true } }
    case 'waitFor':
      if (step.selector === undefined) throw new Error('ui.waitFor requires selector')
      await page.locator(step.selector).waitFor({ state: 'visible', timeout })
      return { output: { selector: step.selector, visible: true } }
    case 'assertText': {
      if (step.selector === undefined || step.text === undefined) throw new Error('ui.assertText requires selector and text')
      const actual = (await page.locator(step.selector).textContent({ timeout })) ?? ''
      const passed = actual.includes(step.text)
      return {
        output: { selector: step.selector, actual, expected: step.text },
        checks: [{ path: 'text', operator: 'contains', expected: step.text, actual, passed, message: `expected ${step.selector} to contain "${step.text}"` }],
      }
    }
    case 'assertUrl': {
      if (step.url === undefined) throw new Error('ui.assertUrl requires url')
      const expected = absoluteUrl(step.url, baseUrl)
      const actual = page.url()
      const passed = actual === expected || actual.includes(step.url)
      return {
        output: { actual, expected },
        checks: [{ path: 'url', operator: 'eq', expected, actual, passed, message: `expected URL ${expected}; actual=${actual}` }],
      }
    }
    case 'screenshot': {
      const name = safeName(step.name ?? `screenshot-${Date.now()}`)
      const path = join(evidenceRoot, `${name}.png`)
      await page.screenshot({ path, fullPage: true })
      return { output: { path }, evidence: [path] }
    }
  }
}

class ServiceManager {
  private readonly running = new Map<string, RunningService>()

  constructor(private readonly template: TemplateContext, private readonly signal?: AbortSignal) {}

  async start(step: QaServiceStartStep): Promise<StepExecution> {
    if (this.running.has(step.service)) return { output: { service: step.service, reused: true, owned: true } }
    const raw = this.template.environment.services?.[step.service]
    if (raw === undefined) throw new Error(`BLOCKED: service "${step.service}" is not configured`)
    const config = resolveTemplate(raw, this.template)
    const healthUrl = config.healthUrl === undefined ? undefined : absoluteUrl(config.healthUrl, this.template.environment.baseUrl)
    if (healthUrl !== undefined && await isHealthy(healthUrl, config.healthExpectedStatus ?? 200, 1500)) {
      return { output: { service: step.service, reused: true, owned: false, healthUrl } }
    }
    if (config.command.length === 0) throw new Error(`service "${step.service}" command cannot be empty`)
    const cwd = safeWorkspacePath(this.template.workspace, config.cwd ?? '.')
    const child = spawn(config.command[0]!, config.command.slice(1), {
      cwd,
      env: { ...process.env, ...(config.env ?? {}) },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const running: RunningService = { name: step.service, child, stdout: '', stderr: '' }
    child.stdout?.on('data', chunk => { running.stdout = (running.stdout + String(chunk)).slice(-200_000) })
    child.stderr?.on('data', chunk => { running.stderr = (running.stderr + String(chunk)).slice(-200_000) })
    this.running.set(step.service, running)
    const onAbort = (): void => { child.kill('SIGTERM') }
    this.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await waitForService(running, healthUrl, config.healthExpectedStatus ?? 200, config.startupTimeoutMs ?? step.timeoutMs ?? 60_000, this.signal)
    } catch (cause) {
      child.kill('SIGTERM')
      this.running.delete(step.service)
      throw new Error(`${errorMessage(cause)}\nstdout:\n${running.stdout}\nstderr:\n${running.stderr}`)
    } finally {
      this.signal?.removeEventListener('abort', onAbort)
    }
    return { output: { service: step.service, reused: false, owned: true, pid: child.pid ?? 0, ...(healthUrl ? { healthUrl } : {}) } }
  }

  async close(): Promise<void> {
    for (const service of [...this.running.values()].reverse()) {
      if (service.child.exitCode !== null) continue
      service.child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>(resolvePromise => { service.child.once('close', () => { resolvePromise() }) }),
        new Promise<void>(resolvePromise => { setTimeout(resolvePromise, 5000).unref() }),
      ])
      if (service.child.exitCode === null) service.child.kill('SIGKILL')
    }
    this.running.clear()
  }
}

function selectCases(config: QaConfig, options: QaRunOptions): QaCase[] {
  const suiteIds = new Set(options.suiteIds ?? [])
  const caseIds = new Set(options.caseIds ?? [])
  const tags = new Set(options.tags ?? [])
  return config.suites
    .filter(suite => suiteIds.size === 0 || suiteIds.has(suite.id))
    .flatMap(suite => suite.cases)
    .filter(testCase => caseIds.size === 0 || caseIds.has(testCase.id))
    .filter(testCase => tags.size === 0 || testCase.tags?.some(tag => tags.has(tag)))
}

function caseBlockReason(testCase: QaCase, options: QaRunOptions, config: QaConfig, statuses: Map<string, QaStatus>): string | undefined {
  for (const dependency of testCase.dependsOn ?? []) {
    const status = statuses.get(dependency)
    if (status !== 'passed') return `BLOCKED: dependency case "${dependency}" did not pass (status=${status ?? 'not-run'})`
  }
  const risk = testCase.risk ?? 'read'
  if ((risk === 'write' || risk === 'destructive') && options.confirmWrite !== true) {
    return `BLOCKED: case "${testCase.id}" requires explicit write confirmation`
  }
  if (risk === 'destructive' && (config.allowDestructive !== true || options.confirmDestructive !== true)) {
    return `BLOCKED: destructive case "${testCase.id}" requires config allowDestructive=true and explicit destructive confirmation`
  }
  return undefined
}

function defaultTestCommand(framework: string, cwd: string, path?: string): string[] {
  switch (framework) {
    case 'maven': {
      const command = existsSync(join(cwd, 'mvnw')) ? './mvnw' : 'mvn'
      return path === undefined ? [command, 'test'] : [command, `-Dtest=${path}`, 'test']
    }
    case 'gradle': {
      const command = existsSync(join(cwd, 'gradlew')) ? './gradlew' : 'gradle'
      return path === undefined ? [command, 'test'] : [command, 'test', '--tests', path]
    }
    case 'pytest': return ['python', '-m', 'pytest', ...(path === undefined ? [] : [path])]
    case 'vitest': return ['npx', 'vitest', 'run', ...(path === undefined ? [] : [path])]
    case 'jest': return ['npx', 'jest', ...(path === undefined ? [] : [path])]
    default: return []
  }
}

function assertReadOnlySql(sql: string): void {
  const withoutComments = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
  if (withoutComments === '') throw new Error('database query cannot be empty')
  if (withoutComments.replace(/;\s*$/, '').includes(';')) throw new Error('database query must contain one statement')
  const normalized = withoutComments
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .toLowerCase()
  if (!/^(select|with|show|describe|explain)\b/.test(normalized)) {
    throw new Error('database adapter allows only SELECT, WITH, SHOW, DESCRIBE, or EXPLAIN')
  }
  if (/\b(insert|update|delete|replace|merge|alter|drop|truncate|create|grant|revoke|call|load|outfile|dumpfile)\b/.test(normalized)) {
    throw new Error('database adapter rejected a mutating SQL keyword')
  }
}

async function waitForService(service: RunningService, healthUrl: string | undefined, expected: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('service startup aborted')
    if (service.child.exitCode !== null) throw new Error(`service "${service.name}" exited with code ${service.child.exitCode}`)
    if (healthUrl === undefined) {
      await delay(750)
      if (service.child.exitCode === null) return
    } else if (await isHealthy(healthUrl, expected, 1500)) return
    await delay(500)
  }
  throw new Error(`service "${service.name}" did not become healthy within ${timeoutMs}ms`)
}

async function isHealthy(url: string, expected: number, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: timeoutSignal(timeoutMs) })
    return response.status === expected
  } catch {
    return false
  }
}

function timeoutSignal(timeoutMs = 30_000, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout])
}

function absoluteUrl(value: string, baseUrl?: string): string {
  if (/^https?:\/\//i.test(value)) return value
  if (baseUrl === undefined) throw new Error(`relative URL "${value}" requires environment.baseUrl`)
  return new URL(value, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase())
}

function aggregateCaseStatus(steps: QaStepResult[]): QaStatus {
  if (steps.some(step => step.status === 'failed')) return 'failed'
  if (steps.some(step => step.status === 'blocked')) return 'blocked'
  if (steps.length > 0 && steps.every(step => step.status === 'skipped')) return 'skipped'
  return 'passed'
}

function skippedStep(step: QaStep, reason: string): QaStepResult {
  return {
    id: step.id, name: step.name ?? step.id, type: step.type, status: 'skipped',
    startedAt: new Date().toISOString(), durationMs: 0, checks: [], error: reason,
  }
}

function issueFromStep(sequence: number, testCase: QaCase, step: QaStepResult): QaIssue {
  const failedCheck = step.checks.find(check => !check.passed)
  return {
    id: `QA-${String(sequence).padStart(3, '0')}`,
    severity: severityFor(testCase, step),
    category: step.type,
    caseId: testCase.id,
    stepId: step.id,
    title: `${testCase.name} / ${step.name} ${step.status === 'blocked' ? '被阻塞' : '失败'}`,
    ...(failedCheck?.expected !== undefined ? { expected: failedCheck.expected } : {}),
    ...(failedCheck?.actual !== undefined ? { actual: failedCheck.actual } : {}),
    ...(step.error !== undefined ? { error: step.error } : {}),
    evidence: step.evidence ?? [],
    suggestion: suggestionFor(step.type, step.status),
  }
}

function severityFor(testCase: QaCase, step: QaStepResult): QaIssueSeverity {
  const configured = testCase.steps.find(candidate => candidate.id === step.id)?.severity
  if (configured !== undefined) return configured
  return step.status === 'blocked' || testCase.risk === 'destructive' ? 'critical' : 'major'
}

function suggestionFor(type: QaStep['type'], status: QaStatus): string {
  if (status === 'blocked') return '先恢复缺失的环境、凭据、依赖服务或人工确认，再重跑该用例。'
  if (type === 'ui') return '结合失败截图、元素定位和同期 API/日志证据检查页面状态与前后端契约。'
  if (type === 'api') return '核对请求契约、响应状态与服务日志；不要仅修改页面展示掩盖后端错误。'
  if (type === 'db.query') return '核对业务写入链路、事务与查询条件；保持数据库校验只读。'
  if (type === 'log.query') return '核对日志查询时间窗、traceId/业务主键和服务实际执行结果。'
  if (type === 'service.start') return '检查启动命令、端口、健康检查和服务启动日志。'
  return '根据测试输出定位首个失败断言，修复后重新执行关联用例。'
}

function isBlockedError(message: string): boolean {
  return message.startsWith('BLOCKED:') || /is not configured|required .* missing|does not exist/i.test(message)
}

function maskReport(report: QaRunReport, secrets: Set<string>): void {
  const masked = redact(JSON.stringify(report), secrets)
  Object.assign(report, JSON.parse(masked) as QaRunReport)
}

function createRunId(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') + '-' + Math.random().toString(36).slice(2, 8)
}

function safeName(value: string): string {
  return basename(value).replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })
}

export const qaEngineInternals = { assertReadOnlySql, absoluteUrl, aggregateCaseStatus, defaultTestCommand }
