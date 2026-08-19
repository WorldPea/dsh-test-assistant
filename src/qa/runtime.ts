import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  JsonValue, QaCheck, QaCheckResult, QaCodeCoverage, QaEnvironment,
} from './types.js'

export interface TemplateContext {
  workspace: string
  runId: string
  environment: QaEnvironment
  steps: Map<string, JsonValue>
  secretValues: Set<string>
}

export function resolveTemplate<T>(value: T, context: TemplateContext): T {
  if (typeof value === 'string') return resolveString(value, context) as T
  if (Array.isArray(value)) return value.map(item => resolveTemplate(item, context)) as T
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) result[key] = resolveTemplate(item, context)
    return result as T
  }
  return value
}

function resolveString(value: string, context: TemplateContext): unknown {
  const exact = value.match(/^\$\{([^}]+)\}$/)
  if (exact !== null) return resolveReference(exact[1]!, context)
  return value.replace(/\$\{([^}]+)\}/g, (_match, reference: string) => {
    const resolved = resolveReference(reference, context)
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
  })
}

function resolveReference(reference: string, context: TemplateContext): unknown {
  if (reference === 'workspace') return context.workspace
  if (reference === 'runId') return context.runId
  if (reference.startsWith('env:')) {
    const name = reference.slice(4)
    const value = process.env[name]
    if (value === undefined) throw new Error(`required environment variable "${name}" is missing`)
    if (/PASSWORD|TOKEN|SECRET|KEY/i.test(name) && value !== '') context.secretValues.add(value)
    return value
  }
  if (reference.startsWith('vars:')) {
    const name = reference.slice(5)
    const value = context.environment.variables?.[name]
    if (value === undefined) throw new Error(`environment variable "${name}" is not configured`)
    return value
  }
  if (reference.startsWith('steps:')) {
    const [, stepId, ...path] = reference.split(':')
    if (stepId === undefined) throw new Error(`invalid step reference "${reference}"`)
    const output = context.steps.get(stepId)
    if (output === undefined) throw new Error(`step reference "${stepId}" is unavailable`)
    const value = path.length === 0 ? output : getPath(output, path.join(':'))
    if (value === undefined) throw new Error(`step reference "${reference}" resolved to undefined`)
    return value
  }
  throw new Error(`unsupported template reference "${reference}"`)
}

export function runChecks(subject: JsonValue, checks: QaCheck[] = []): QaCheckResult[] {
  return checks.map(check => {
    const actual = getPath(subject, check.path)
    const passed = evaluate(actual, check.operator, check.expected)
    return {
      path: check.path,
      operator: check.operator,
      ...(check.expected !== undefined ? { expected: check.expected } : {}),
      ...(actual !== undefined ? { actual } : {}),
      passed,
      message: check.message ?? `${check.path} ${check.operator} ${format(check.expected)}; actual=${format(actual)}`,
    }
  })
}

export function getPath(subject: unknown, path: string): JsonValue | undefined {
  if (path === '' || path === '$') return toJsonValue(subject)
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean)
  let current: unknown = subject
  for (const part of parts) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)]
    else if (typeof current === 'object' && current !== null) current = (current as Record<string, unknown>)[part]
    else return undefined
  }
  return toJsonValue(current)
}

function evaluate(actual: JsonValue | undefined, operator: QaCheck['operator'], expected: JsonValue | undefined): boolean {
  switch (operator) {
    case 'exists': return actual !== undefined && actual !== null
    case 'eq': return deepEqual(actual, expected)
    case 'ne': return !deepEqual(actual, expected)
    case 'contains': return typeof actual === 'string'
      ? actual.includes(String(expected ?? ''))
      : Array.isArray(actual) && actual.some(item => deepEqual(item, expected))
    case 'notContains': return typeof actual === 'string'
      ? !actual.includes(String(expected ?? ''))
      : Array.isArray(actual) && !actual.some(item => deepEqual(item, expected))
    case 'matches': return typeof actual === 'string' && new RegExp(String(expected ?? '')).test(actual)
    case 'gt': return numeric(actual) > numeric(expected)
    case 'gte': return numeric(actual) >= numeric(expected)
    case 'lt': return numeric(actual) < numeric(expected)
    case 'lte': return numeric(actual) <= numeric(expected)
  }
}

function numeric(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : Number.NaN
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function format(value: unknown): string {
  return value === undefined ? '<undefined>' : JSON.stringify(value)
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function safeWorkspacePath(workspace: string, value: string): string {
  const target = isAbsolute(value) ? resolve(value) : resolve(workspace, value)
  const rel = relative(resolve(workspace), target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes workspace: ${value}`)
  return target
}

export function redact(value: string, secrets: Iterable<string>): string {
  let result = value
  for (const secret of secrets) {
    if (secret.length >= 3) result = result.split(secret).join('***')
  }
  return result
}

export interface ProcessResult {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export async function runProcess(options: {
  command: string[]
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  maxOutputBytes?: number
}): Promise<ProcessResult> {
  if (options.command.length === 0) throw new Error('command cannot be empty')
  const started = Date.now()
  const max = options.maxOutputBytes ?? 2 * 1024 * 1024
  let stdout = ''
  let stderr = ''
  let timedOut = false
  return await new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(options.command[0]!, options.command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const value = chunk.toString('utf8')
      if (target === 'stdout') stdout = (stdout + value).slice(-max)
      else stderr = (stderr + value).slice(-max)
    }
    child.stdout.on('data', chunk => { append('stdout', chunk) })
    child.stderr.on('data', chunk => { append('stderr', chunk) })
    const terminate = (): void => {
      if (!child.killed) child.kill('SIGTERM')
    }
    options.signal?.addEventListener('abort', terminate, { once: true })
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      terminate()
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 1000).unref()
    }, options.timeoutMs)
    timer?.unref()
    child.on('error', reject)
    child.on('close', code => {
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', terminate)
      resolvePromise({
        command: options.command,
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      })
    })
  })
}

export function readCodeCoverage(workspace: string, project: string, framework: string, requested?: string): QaCodeCoverage | undefined {
  const candidates = requested !== undefined
    ? [requested]
    : framework === 'maven'
      ? ['target/site/jacoco/jacoco.csv']
      : framework === 'gradle'
        ? ['build/reports/jacoco/test/jacocoTestReport.csv']
        : framework === 'pytest'
          ? ['coverage.json']
          : ['coverage/coverage-summary.json']
  for (const candidate of candidates) {
    const source = safeWorkspacePath(workspace, join(project, candidate))
    if (!existsSync(source)) continue
    try {
      const percent = source.endsWith('.csv') ? readJacocoCsv(source) : readJsonCoverage(source)
      if (percent !== undefined) return { project, framework, percent, source }
    } catch {
      continue
    }
  }
  return undefined
}

function readJacocoCsv(path: string): number | undefined {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/)
  if (lines.length < 2) return undefined
  const headers = lines[0]!.split(',')
  const missedIndex = headers.indexOf('LINE_MISSED')
  const coveredIndex = headers.indexOf('LINE_COVERED')
  if (missedIndex < 0 || coveredIndex < 0) return undefined
  let missed = 0
  let covered = 0
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    missed += Number(cells[missedIndex] ?? 0)
    covered += Number(cells[coveredIndex] ?? 0)
  }
  return percentage(covered, covered + missed)
}

function readJsonCoverage(path: string): number | undefined {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  const total = data.total ?? data.totals
  if (typeof total?.lines?.pct === 'number') return round(total.lines.pct)
  const files = Object.values(data.files ?? {}) as Array<Record<string, any>>
  if (files.length > 0) {
    const covered = files.reduce((sum, file) => sum + Number(file.summary?.covered_lines ?? file.covered_lines ?? 0), 0)
    const count = files.reduce((sum, file) => sum + Number(file.summary?.num_statements ?? file.num_statements ?? 0), 0)
    return percentage(covered, count)
  }
  return undefined
}

export function percentage(covered: number, total: number): number {
  return total === 0 ? 0 : round(covered * 100 / total)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
