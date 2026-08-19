import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { validateQaConfig, resolveConfigPath } from './config.js'
import { discoverQaWorkspace } from './discovery.js'
import { runQaPlan } from './engine.js'
import { readRunReport } from './report.js'
import type { QaRunReport } from './types.js'
import { existsSync, readFileSync } from 'node:fs'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function workspaceOf(exec: ToolRunContext): string {
  const workspace = exec.agent?.session.header.cwd
  if (workspace === undefined) throw new Error('QA tool requires a Harness session with a workspace')
  return workspace
}

const PROJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    path: { type: 'string', required: true },
    framework: { type: 'string', required: true },
    testCommand: { type: 'array', items: { type: 'string' }, required: true },
    coverageFiles: { type: 'array', items: { type: 'string' }, required: true },
  },
} as const

export function qaDiscoverTool() {
  return defineTool({
    name: 'qa_discover',
    description: '识别当前 Harness 工作区中的 Java Maven/Gradle、Python 和前端项目，以及端到端 QA 配置位置。执行测试任务前先调用。',
    parameters: {
      configPath: { type: 'string', description: '可选 QA 配置路径；默认 .dsh/qa.e2e.json。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          workspace: { type: 'string', required: true },
          configPath: { type: 'string', required: true },
          configExists: { type: 'boolean', required: true },
          projects: { type: 'array', items: PROJECT_SCHEMA, required: true },
        },
      },
      render: (_args, value: ReturnType<typeof discoverQaWorkspace>) => text([
        `工作区: ${value.workspace}`,
        `QA 配置: ${value.configPath} (${value.configExists ? '存在' : '缺失'})`,
        ...value.projects.map(project => `- ${project.kind} ${project.path} / ${project.framework}`),
      ].join('\n')),
    },
    isConcurrencySafe: () => true,
    async execute(args: { configPath?: string }, exec) {
      return discoverQaWorkspace(workspaceOf(exec), args.configPath)
    },
  })
}

export function qaValidateTool() {
  return defineTool({
    name: 'qa_validate',
    description: '只读校验端到端 QA 配置、步骤契约和所需环境变量。不会启动服务、打开页面或连接数据库。',
    parameters: {
      configPath: { type: 'string', description: '可选 QA 配置路径；默认 .dsh/qa.e2e.json。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true },
          configPath: { type: 'string', required: true },
          errors: { type: 'array', items: { type: 'string' }, required: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
          missingEnvironmentVariables: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value: { valid: boolean; configPath: string; errors: string[]; warnings: string[]; missingEnvironmentVariables: string[] }) => text([
        `配置: ${value.configPath}`,
        `状态: ${value.valid ? '✅ 合法' : '❌ 不合法'}`,
        ...(value.errors.length > 0 ? ['错误:', ...value.errors.map(error => `- ${error}`)] : []),
        ...(value.warnings.length > 0 ? ['警告:', ...value.warnings.map(warning => `- ${warning}`)] : []),
        ...(value.missingEnvironmentVariables.length > 0
          ? ['缺失环境变量:', ...value.missingEnvironmentVariables.map(name => `- ${name}`)]
          : []),
      ].join('\n')),
    },
    isConcurrencySafe: () => true,
    async execute(args: { configPath?: string }, exec) {
      const workspace = workspaceOf(exec)
      const configPath = resolveConfigPath(workspace, args.configPath)
      if (!existsSync(configPath)) {
        return { valid: false, configPath, errors: [`QA config not found: ${configPath}`], warnings: [], missingEnvironmentVariables: [] }
      }
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(configPath, 'utf8')) }
      catch (cause) {
        return { valid: false, configPath, errors: [`QA config is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`], warnings: [], missingEnvironmentVariables: [] }
      }
      const result = validateQaConfig(parsed, configPath)
      return {
        valid: result.valid,
        configPath: result.configPath,
        errors: result.errors,
        warnings: result.warnings,
        missingEnvironmentVariables: result.missingEnvironmentVariables,
      }
    },
  })
}

const ISSUE_SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    severity: { type: 'string', required: true },
    title: { type: 'string', required: true },
    caseId: { type: 'string', required: true },
    stepId: { type: 'string', required: true },
    error: { type: 'string', required: true },
  },
} as const

const REPORT_SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    runId: { type: 'string', required: true },
    status: { type: 'string', enum: ['passed', 'failed', 'blocked', 'skipped'], required: true },
    environment: { type: 'string', required: true },
    passRate: { type: 'number', required: true },
    requirementCoverage: { type: 'number', required: true },
    caseCoverage: { type: 'number', required: true },
    stepCoverage: { type: 'number', required: true },
    issueCount: { type: 'integer', required: true },
    reportJson: { type: 'string', required: true },
    reportMarkdown: { type: 'string', required: true },
    issues: { type: 'array', items: ISSUE_SUMMARY_SCHEMA, required: true },
  },
} as const

export function qaRunTool() {
  return defineTool({
    name: 'qa_run',
    description: '执行端到端 QA 流程：Java/Python/前端测试、服务启动、Playwright 页面操作、API、只读 MySQL 和日志校验，并生成覆盖率、通过率、证据与问题报告。写/破坏性用例必须先得到用户明确确认。',
    parameters: {
      configPath: { type: 'string', description: '可选 QA 配置路径；默认 .dsh/qa.e2e.json。' },
      environment: { type: 'string', description: '环境名；默认配置的 defaultEnvironment。' },
      suiteIds: { type: 'array', items: { type: 'string' }, description: '只执行这些 suite。' },
      caseIds: { type: 'array', items: { type: 'string' }, description: '只执行这些 case。' },
      tags: { type: 'array', items: { type: 'string' }, description: '只执行命中任一标签的 case。' },
      confirmWrite: { type: 'boolean', description: '仅在用户明确确认允许写测试数据后设为 true。' },
      confirmDestructive: { type: 'boolean', description: '仅在用户明确二次确认破坏性测试后设为 true。' },
    },
    output: {
      schema: REPORT_SUMMARY_SCHEMA,
      render: (_args, value: ReportSummary) => text(renderSummary(value)),
    },
    timeoutMs: 30 * 60_000,
    async execute(args: {
      configPath?: string; environment?: string; suiteIds?: string[]; caseIds?: string[]; tags?: string[]
      confirmWrite?: boolean; confirmDestructive?: boolean
    }, exec) {
      const report = await runQaPlan({ workspace: workspaceOf(exec), ...args, signal: exec.signal })
      return summarize(report)
    },
  })
}

export function qaReportTool() {
  return defineTool({
    name: 'qa_report',
    description: '读取当前工作区最近一次或指定 runId 的端到端 QA 报告摘要。',
    parameters: {
      runId: { type: 'string', description: '可选运行 ID；默认读取 latest.json。' },
      artifactsDir: { type: 'string', description: '可选报告目录；默认 .dsh/qa-runs。' },
    },
    output: {
      schema: REPORT_SUMMARY_SCHEMA,
      render: (_args, value: ReportSummary) => text(renderSummary(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args: { runId?: string; artifactsDir?: string }, exec) {
      return summarize(readRunReport(workspaceOf(exec), args.runId, args.artifactsDir))
    },
  })
}

export function qaTaskTemplateTool() {
  return defineTool({
    name: 'qa_task_template',
    description: '生成可直接填入 DeepSeek Harness 任务看板的端到端测试任务标题、说明和 Prompt；任务看板负责调度，qa_* 工具负责执行与报告。',
    parameters: {
      title: { type: 'string', required: true, description: '任务标题，如 每日登录回归。' },
      environment: { type: 'string', description: 'QA 环境名。' },
      suiteIds: { type: 'array', items: { type: 'string' }, description: '要执行的 suite。' },
      caseIds: { type: 'array', items: { type: 'string' }, description: '要执行的 case。' },
      documentPaths: { type: 'array', items: { type: 'string' }, description: '可选测试用例/PRD/Markdown/CSV 文档路径。' },
      allowWrite: { type: 'boolean', description: '任务是否经过用户确认允许写测试数据。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          description: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          recommendedPermission: { type: 'string', required: true },
        },
      },
      render: (_args, value: { title: string; description: string; prompt: string; recommendedPermission: string }) => text([
        `标题: ${value.title}`,
        `推荐权限: ${value.recommendedPermission}`,
        `说明: ${value.description}`,
        '',
        '--- 任务 Prompt ---',
        value.prompt,
      ].join('\n')),
    },
    isConcurrencySafe: () => true,
    async execute(args: { title: string; environment?: string; suiteIds?: string[]; caseIds?: string[]; documentPaths?: string[]; allowWrite?: boolean }) {
      const filters = [
        ...(args.environment ? [`环境=${args.environment}`] : []),
        ...(args.suiteIds?.length ? [`suite=${args.suiteIds.join(',')}`] : []),
        ...(args.caseIds?.length ? [`case=${args.caseIds.join(',')}`] : []),
      ].join('；') || '使用配置默认范围'
      const docs = args.documentPaths?.length
        ? `先读取这些测试用例/需求文档：${args.documentPaths.join('、')}。如果结构化配置缺失或文档已变更，先生成或更新 .dsh/qa.e2e.json；遇到业务口径歧义必须列出待确认项并停止，不能猜测。`
        : '以工作区 .dsh/qa.e2e.json 为测试事实源。'
      const prompt = [
        '执行本工作区的端到端 QA 自动化任务。',
        docs,
        '步骤：',
        '1. 调用 qa_discover，确认 Java/Python/前端子项目、当前工作区和 QA 配置。',
        '2. 调用 qa_validate；配置错误、凭据缺失或依赖环境不完整时停止，并输出阻塞清单。',
        `3. 调用 qa_run，${filters}；confirmWrite=${args.allowWrite === true ? 'true（用户已确认）' : 'false'}，不得执行未经确认的写/破坏性用例。`,
        '4. 调用 qa_report，汇总通过率、需求/用例/步骤/代码覆盖率、证据路径和待修复问题。',
        '5. qa_run 的 status 不是 passed 时，必须明确写“测试失败”或“测试被阻塞”；不得把“执行完成”表述成“测试通过”。',
      ].join('\n')
      return {
        title: args.title,
        description: `端到端 QA 自动化：${filters}`,
        prompt,
        recommendedPermission: args.allowWrite === true ? 'workspace-write' : 'read-only',
      }
    },
  })
}

interface ReportSummary {
  runId: string
  status: QaRunReport['status']
  environment: string
  passRate: number
  requirementCoverage: number
  caseCoverage: number
  stepCoverage: number
  issueCount: number
  reportJson: string
  reportMarkdown: string
  issues: Array<{ id: string; severity: string; title: string; caseId: string; stepId: string; error: string }>
}

function summarize(report: QaRunReport): ReportSummary {
  return {
    runId: report.runId,
    status: report.status,
    environment: report.environment,
    passRate: report.passRate.percent,
    requirementCoverage: report.coverage.requirements.percent,
    caseCoverage: report.coverage.cases.percent,
    stepCoverage: report.coverage.steps.percent,
    issueCount: report.issues.length,
    reportJson: report.artifacts.json,
    reportMarkdown: report.artifacts.markdown,
    issues: report.issues.slice(0, 20).map(issue => ({
      id: issue.id,
      severity: issue.severity,
      title: issue.title,
      caseId: issue.caseId,
      stepId: issue.stepId,
      error: issue.error ?? '',
    })),
  }
}

function renderSummary(value: ReportSummary): string {
  return [
    `运行: ${value.runId}`,
    `状态: ${value.status === 'passed' ? '✅ 通过' : value.status === 'failed' ? '❌ 失败' : '⛔ 阻塞'}`,
    `环境: ${value.environment}`,
    `通过率: ${value.passRate}%`,
    `需求/用例/步骤覆盖率: ${value.requirementCoverage}% / ${value.caseCoverage}% / ${value.stepCoverage}%`,
    `待修复问题: ${value.issueCount}`,
    `JSON 报告: ${value.reportJson}`,
    `Markdown 报告: ${value.reportMarkdown}`,
    ...value.issues.map(issue => `- ${issue.id} [${issue.severity}] ${issue.title}${issue.error ? `: ${issue.error}` : ''}`),
  ].join('\n')
}

export function qaTools() {
  return [qaDiscoverTool(), qaValidateTool(), qaRunTool(), qaReportTool(), qaTaskTemplateTool()]
}
