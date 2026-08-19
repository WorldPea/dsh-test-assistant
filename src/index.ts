/**
 * dsh-test-assistant — Host 端入口。
 * 注册端到端 QA 编排工具和兼容的项目测试工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { testRunTool, testGenTool, testFixTool } from './tools.js'
import { qaTools } from './qa/tools.js'

/** 稳定的 cordis 插件名 */
export const name = 'test-assistant'

/** 依赖的 cordis 服务 */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** 设置命名空间 */
export const TEST_NS = settingsNamespace('dsh-test-assistant')

/** 插件配置 schema */
export interface Config {
  /** 主开关 */
  enabled?: boolean
  /** 是否向 Agent 宣告能力 */
  announceToAgent?: boolean
  /** 是否自动检测测试框架 */
  autoDetect?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  autoDetect: z.boolean().default(true),
})

/** 系统提示词章节顺序 */
const SECTION_ORDER = 160

/** 注入给 Agent 的测试助手能力声明 */
const TEST_GUIDANCE = `本机已安装 dsh-test-assistant 端到端 QA 插件。能力：
- qa_discover：识别当前会话工作区内的 Java Maven/Gradle、Python 和前端项目。
- qa_validate：只读校验 .dsh/qa.e2e.json、步骤契约和环境变量。
- qa_run：编排服务生命周期、项目测试、Playwright 页面操作、API、只读 MySQL 和日志校验，生成覆盖率、通过率、证据与问题报告。
- qa_report：读取最近一次或指定运行报告。
- qa_task_template：生成可直接填入 Harness 任务看板并支持 cron 调度的标准测试任务 Prompt。
- test_run：兼容执行 Jest / Vitest / pytest 项目测试。
- test_gen：为指定源文件生成测试文件骨架（含框架检测、import 和 describe/it 块）。
- test_fix：分析失败测试，返回每个失败用例的错误信息与修复建议。

端到端任务先调用 qa_discover 和 qa_validate，再调用 qa_run。所有相对路径必须基于调用会话工作区，不得使用 Harness 启动目录。写测试数据必须有用户明确确认；破坏性测试必须二次确认。数据库适配器永远只读。凭据只通过环境变量引用，不写入配置或报告。

任务看板的“执行完成”不等于“测试通过”，必须按 qa_run.status 报告 passed/failed/blocked，并附报告路径与待修复问题。`

/**
 * 挂载测试助手：注册工具、系统提示词章节、设置。
 */
export function apply(ctx: Context, config?: Config): void {
  const cfg = config ?? {}
  let current = () => cfg

  // 工具注册
  const tools = [...qaTools(), testRunTool(), testGenTool(), testFixTool()]
  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    const c = current()
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (!c.enabled) return

    if (c.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-test-assistant',
        order: SECTION_ORDER,
        text: TEST_GUIDANCE,
      })
    }

    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const d of disposers) d() }
      },
      'dsh-test-assistant: tools',
    )
  }

  installSettingsSection(ctx, TEST_NS, Config, cfg, {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  // 浏览器面板只展示能力状态；实际执行必须从有明确工作区的 Agent 工具进入。
  ctx.effect(
    () => {
      const d1 = ctx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-test-assistant/status',
        async handler(req, res) {
          if (req.method !== 'GET') {
            res.writeHead(405).end()
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            enabled: true,
            capabilities: ['java', 'python', 'frontend', 'ui', 'api', 'mysql-readonly', 'logs', 'task-board'],
            configPath: '.dsh/qa.e2e.json',
          }))
        },
      })
      return () => { d1() }
    },
    'dsh-test-assistant: capability api',
  )

  sync()
}
