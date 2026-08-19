import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  QaCase, QaCaseResult, QaCodeCoverage, QaConfig, QaCoverageMetric, QaIssue,
  QaRunReport, QaStatus,
} from './types.js'
import { percentage, safeWorkspacePath } from './runtime.js'

export function createRunReport(input: {
  runId: string
  workspace: string
  environment: string
  startedAt: string
  finishedAt: string
  selectedCases: QaCase[]
  allRequirements: string[]
  cases: QaCaseResult[]
  codeCoverage: QaCodeCoverage[]
  issues: QaIssue[]
  artifactsRoot: string
}): QaRunReport {
  const passRate = summarizeStatuses(input.cases.map(testCase => testCase.status))
  const selectedSteps = input.selectedCases.reduce((sum, testCase) => sum + testCase.steps.length, 0)
  const executedSteps = input.cases.reduce(
    (sum, testCase) => sum + testCase.steps.filter(step => step.status !== 'skipped').length,
    0,
  )
  const coveredRequirements = new Set(
    input.cases.filter(testCase => testCase.status !== 'skipped').flatMap(testCase => testCase.requirements),
  )
  const artifacts = {
    directory: input.artifactsRoot,
    json: join(input.artifactsRoot, 'report.json'),
    markdown: join(input.artifactsRoot, 'report.md'),
  }
  return {
    runId: input.runId,
    workspace: input.workspace,
    environment: input.environment,
    status: aggregateStatus(input.cases.map(testCase => testCase.status)),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime(),
    passRate,
    coverage: {
      requirements: metric(coveredRequirements.size, input.allRequirements.length),
      cases: metric(input.cases.filter(testCase => testCase.status !== 'skipped').length, input.selectedCases.length),
      steps: metric(executedSteps, selectedSteps),
      code: input.codeCoverage,
    },
    cases: input.cases,
    issues: input.issues,
    artifacts,
  }
}

export function writeRunReport(report: QaRunReport): void {
  mkdirSync(report.artifacts.directory, { recursive: true })
  writeFileSync(report.artifacts.json, JSON.stringify(report, null, 2) + '\n', 'utf8')
  writeFileSync(report.artifacts.markdown, renderMarkdown(report), 'utf8')
}

export function readRunReport(workspace: string, runId?: string, artifactsDir = '.dsh/qa-runs'): QaRunReport {
  const root = safeWorkspacePath(workspace, artifactsDir)
  const target = runId === undefined ? join(root, 'latest.json') : join(root, runId, 'report.json')
  return JSON.parse(readFileSync(target, 'utf8')) as QaRunReport
}

export function writeLatestPointer(report: QaRunReport, artifactsBase: string): void {
  mkdirSync(artifactsBase, { recursive: true })
  writeFileSync(join(artifactsBase, 'latest.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
}

function renderMarkdown(report: QaRunReport): string {
  const lines = [
    `# QA 自动化报告 ${report.runId}`,
    '',
    `- 环境：${report.environment}`,
    `- 状态：${statusLabel(report.status)}`,
    `- 耗时：${report.durationMs}ms`,
    `- 通过率：${report.passRate.percent}%（通过 ${report.passRate.passed} / 总计 ${report.passRate.total}）`,
    `- 需求覆盖率：${report.coverage.requirements.percent}%`,
    `- 用例覆盖率：${report.coverage.cases.percent}%`,
    `- 步骤覆盖率：${report.coverage.steps.percent}%`,
    '',
    '## 用例结果',
    '',
  ]
  for (const testCase of report.cases) {
    lines.push(`### ${statusLabel(testCase.status)} ${testCase.id} ${testCase.name}`, '')
    for (const step of testCase.steps) {
      lines.push(`- ${statusLabel(step.status)} ${step.id} (${step.type}) ${step.durationMs}ms${step.error ? `：${step.error}` : ''}`)
    }
    lines.push('')
  }
  lines.push('## 代码覆盖率', '')
  if (report.coverage.code.length === 0) lines.push('- 未发现代码覆盖率产物。', '')
  else for (const coverage of report.coverage.code) {
    lines.push(`- ${coverage.project} / ${coverage.framework}: ${coverage.percent}%（${coverage.source}）`)
  }
  lines.push('', '## 待修复问题', '')
  if (report.issues.length === 0) lines.push('没有检测到失败或阻塞问题。')
  for (const issue of report.issues) {
    lines.push(
      `### ${issue.severity.toUpperCase()} ${issue.id} ${issue.title}`,
      '',
      `- 类别：${issue.category}`,
      `- 用例/步骤：${issue.caseId} / ${issue.stepId}`,
      ...(issue.error ? [`- 错误：${issue.error}`] : []),
      ...(issue.expected !== undefined ? [`- 期望：\`${JSON.stringify(issue.expected)}\``] : []),
      ...(issue.actual !== undefined ? [`- 实际：\`${JSON.stringify(issue.actual)}\``] : []),
      `- 建议：${issue.suggestion}`,
      ...(issue.evidence.length > 0 ? [`- 证据：${issue.evidence.join(', ')}`] : []),
      '',
    )
  }
  return lines.join('\n') + '\n'
}

function metric(covered: number, total: number): QaCoverageMetric {
  return { covered, total, percent: percentage(covered, total) }
}

function summarizeStatuses(statuses: QaStatus[]): QaRunReport['passRate'] {
  const passed = statuses.filter(status => status === 'passed').length
  const failed = statuses.filter(status => status === 'failed').length
  const blocked = statuses.filter(status => status === 'blocked').length
  const skipped = statuses.filter(status => status === 'skipped').length
  const executed = passed + failed + blocked
  return { passed, failed, blocked, skipped, total: statuses.length, percent: percentage(passed, executed) }
}

function aggregateStatus(statuses: QaStatus[]): QaStatus {
  if (statuses.some(status => status === 'failed')) return 'failed'
  if (statuses.some(status => status === 'blocked')) return 'blocked'
  if (statuses.length > 0 && statuses.every(status => status === 'skipped')) return 'skipped'
  return 'passed'
}

function statusLabel(status: QaStatus): string {
  return status === 'passed' ? '✅' : status === 'failed' ? '❌' : status === 'blocked' ? '⛔' : '⏭️'
}
