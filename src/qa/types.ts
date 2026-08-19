export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type QaProjectKind = 'java-maven' | 'java-gradle' | 'python' | 'frontend'
export type QaRisk = 'read' | 'write' | 'destructive'
export type QaStatus = 'passed' | 'failed' | 'blocked' | 'skipped'
export type QaIssueSeverity = 'critical' | 'major' | 'minor'

export interface QaRequirement {
  id: string
  title: string
  risk?: QaIssueSeverity
}

export interface QaBrowserAction {
  action: 'goto' | 'fill' | 'click' | 'press' | 'waitFor' | 'assertText' | 'assertUrl' | 'screenshot'
  url?: string
  selector?: string
  value?: string
  key?: string
  text?: string
  timeoutMs?: number
  name?: string
}

export interface QaBrowserConfig {
  channel?: string
  executablePath?: string
  headless?: boolean
  ignoreHTTPSErrors?: boolean
  storageStatePath?: string
  viewport?: { width: number; height: number }
  setup?: QaBrowserAction[]
}

export interface QaMysqlConfig {
  type: 'mysql'
  hostEnv: string
  port?: number
  databaseEnv: string
  userEnv: string
  passwordEnv: string
  connectTimeoutMs?: number
  ssl?: boolean
  maxRows?: number
}

export interface QaHttpLogSource {
  type: 'http'
  url: string
  method?: string
  headers?: Record<string, string>
  queryField?: string
  baseBody?: Record<string, JsonValue>
  timeoutMs?: number
}

export interface QaFileLogSource {
  type: 'file'
  path: string
  maxBytes?: number
}

export type QaLogSource = QaHttpLogSource | QaFileLogSource

export interface QaServiceConfig {
  cwd?: string
  command: string[]
  env?: Record<string, string>
  healthUrl?: string
  healthExpectedStatus?: number
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
}

export interface QaEnvironment {
  baseUrl?: string
  variables?: Record<string, JsonPrimitive>
  browser?: QaBrowserConfig
  database?: QaMysqlConfig
  logs?: Record<string, QaLogSource>
  services?: Record<string, QaServiceConfig>
}

export type QaCheckOperator = 'eq' | 'ne' | 'contains' | 'notContains' | 'matches' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte'

export interface QaCheck {
  path: string
  operator: QaCheckOperator
  expected?: JsonValue
  message?: string
}

interface QaStepBase {
  id: string
  name?: string
  timeoutMs?: number
  continueOnFailure?: boolean
  severity?: QaIssueSeverity
}

export interface QaServiceStartStep extends QaStepBase {
  type: 'service.start'
  service: string
}

export interface QaProjectTestStep extends QaStepBase {
  type: 'project.test'
  project?: string
  framework?: 'auto' | 'maven' | 'gradle' | 'pytest' | 'vitest' | 'jest' | 'script'
  path?: string
  command?: string[]
  coverageFile?: string
}

export interface QaUiStep extends QaStepBase, QaBrowserAction {
  type: 'ui'
}

export interface QaApiStep extends QaStepBase {
  type: 'api'
  method?: string
  url: string
  /** Reuse cookies established by browser setup/login. */
  useBrowserSession?: boolean
  headers?: Record<string, string>
  body?: JsonValue
  checks?: QaCheck[]
}

export interface QaDbStep extends QaStepBase {
  type: 'db.query'
  sql: string
  params?: JsonValue[]
  checks?: QaCheck[]
}

export interface QaLogStep extends QaStepBase {
  type: 'log.query'
  source: string
  query?: string
  body?: Record<string, JsonValue>
  checks?: QaCheck[]
}

export type QaStep = QaServiceStartStep | QaProjectTestStep | QaUiStep | QaApiStep | QaDbStep | QaLogStep

export interface QaCase {
  id: string
  name: string
  risk?: QaRisk
  tags?: string[]
  requirements?: string[]
  dependsOn?: string[]
  continueOnFailure?: boolean
  steps: QaStep[]
}

export interface QaSuite {
  id: string
  name: string
  cases: QaCase[]
}

export interface QaConfig {
  version: 1
  defaultEnvironment?: string
  artifactsDir?: string
  allowDestructive?: boolean
  requirements?: QaRequirement[]
  environments: Record<string, QaEnvironment>
  suites: QaSuite[]
}

export interface QaDetectedProject {
  kind: QaProjectKind
  path: string
  framework: string
  testCommand: string[]
  coverageFiles: string[]
}

export interface QaDiscovery {
  workspace: string
  configPath: string
  configExists: boolean
  projects: QaDetectedProject[]
}

export interface QaCheckResult {
  path: string
  operator: QaCheckOperator
  expected?: JsonValue
  actual?: JsonValue
  passed: boolean
  message: string
}

export interface QaStepResult {
  id: string
  name: string
  type: QaStep['type']
  status: QaStatus
  startedAt: string
  durationMs: number
  output?: JsonValue
  checks: QaCheckResult[]
  error?: string
  evidence?: string[]
}

export interface QaCaseResult {
  id: string
  name: string
  risk: QaRisk
  requirements: string[]
  status: QaStatus
  startedAt: string
  durationMs: number
  steps: QaStepResult[]
}

export interface QaIssue {
  id: string
  severity: QaIssueSeverity
  category: QaStep['type'] | 'config'
  caseId: string
  stepId: string
  title: string
  expected?: JsonValue
  actual?: JsonValue
  error?: string
  evidence: string[]
  suggestion: string
}

export interface QaCoverageMetric {
  covered: number
  total: number
  percent: number
}

export interface QaCodeCoverage {
  project: string
  framework: string
  percent: number
  source: string
}

export interface QaRunReport {
  runId: string
  workspace: string
  environment: string
  status: QaStatus
  startedAt: string
  finishedAt: string
  durationMs: number
  passRate: {
    passed: number
    failed: number
    blocked: number
    skipped: number
    total: number
    percent: number
  }
  coverage: {
    requirements: QaCoverageMetric
    cases: QaCoverageMetric
    steps: QaCoverageMetric
    code: QaCodeCoverage[]
  }
  cases: QaCaseResult[]
  issues: QaIssue[]
  artifacts: {
    directory: string
    json: string
    markdown: string
  }
}

export interface QaRunOptions {
  workspace: string
  configPath?: string
  environment?: string
  suiteIds?: string[]
  caseIds?: string[]
  tags?: string[]
  confirmWrite?: boolean
  confirmDestructive?: boolean
  signal?: AbortSignal
}
