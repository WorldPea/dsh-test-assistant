export const zh = {
  'panel.title': '端到端 QA',
  'panel.description': '编排 Java、Python、前端项目的页面、API、数据库、日志与项目测试。',
  'panel.loading': '正在读取测试助手能力…',
  'panel.ready': '测试助手已就绪',
  'panel.unavailable': '测试助手 Host 能力不可用',
  'panel.config': '执行配置',
  'panel.workflow': '自动化流程',
  'panel.supports': '支持范围',
  'panel.taskBoard': '任务看板集成',
  'panel.copyPrompt': '复制任务 Prompt',
  'panel.copied': '已复制，可在任务看板新建任务时粘贴',
} as const

export type TestKey = keyof typeof zh

export const en: Record<TestKey, string> = {
  'panel.title': 'End-to-end QA',
  'panel.description': 'Orchestrate UI, API, database, logs, and project tests across Java, Python, and frontend projects.',
  'panel.loading': 'Loading QA capabilities…',
  'panel.ready': 'QA assistant is ready',
  'panel.unavailable': 'QA assistant host capabilities are unavailable',
  'panel.config': 'Execution config',
  'panel.workflow': 'Automation workflow',
  'panel.supports': 'Supported stacks',
  'panel.taskBoard': 'Task board integration',
  'panel.copyPrompt': 'Copy task prompt',
  'panel.copied': 'Copied. Paste it into a new Task Board task.',
}
