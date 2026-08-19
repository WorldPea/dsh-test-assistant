import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { TestKey } from './locales.js'

type Translate = (key: TestKey) => string

export interface TestPanelProps {
  t: Translate
}

interface CapabilityStatus {
  enabled: boolean
  capabilities: string[]
  configPath: string
}

const TASK_PROMPT = `执行本工作区的端到端 QA 自动化任务。
1. 调用 qa_discover 识别 Java、Python、前端子项目和 QA 配置。
2. 调用 qa_validate；配置错误、凭据缺失或依赖环境不完整时停止并输出阻塞清单。
3. 调用 qa_run；未经用户确认不得执行 write/destructive 用例。
4. 调用 qa_report，汇总通过率、需求/用例/步骤/代码覆盖率、证据路径和待修复问题。
5. qa_run.status 不是 passed 时，必须明确写测试失败或被阻塞，不能把执行完成表述成测试通过。`

export function TestPanel({ t }: TestPanelProps) {
  const [status, setStatus] = useState<CapabilityStatus | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch('/api/dsh-test-assistant/status')
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json() as CapabilityStatus
      })
      .then(setStatus)
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
  }, [])

  const copyPrompt = async (): Promise<void> => {
    await navigator.clipboard.writeText(TASK_PROMPT)
    setCopied(true)
    setTimeout(() => { setCopied(false) }, 3000)
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div>
          <h2 style={styles.title}>{t('panel.title')}</h2>
          <p style={styles.subtitle}>{t('panel.description')}</p>
        </div>
        <span style={{ ...styles.badge, ...(status?.enabled ? styles.badgeReady : styles.badgeLoading) }}>
          {error ? t('panel.unavailable') : status?.enabled ? t('panel.ready') : t('panel.loading')}
        </span>
      </header>

      {error && <div style={styles.error}>{error}</div>}

      <section style={styles.grid}>
        <Card title={t('panel.supports')}>
          <Pills values={['Java Maven/Gradle', 'Python pytest', 'Frontend Vitest/Jest', 'Playwright UI', 'HTTP API', 'MySQL 只读', '服务日志']} />
        </Card>
        <Card title={t('panel.config')}>
          <code style={styles.code}>{status?.configPath ?? '.dsh/qa.e2e.json'}</code>
          <p style={styles.muted}>凭据使用环境变量；运行证据写入 .dsh/qa-runs。</p>
        </Card>
      </section>

      <Card title={t('panel.workflow')}>
        <div style={styles.flow}>
          {['项目与文档', '配置校验', '启动服务', '页面/API/DB/日志', '覆盖率与问题报告'].map((label, index) => (
            <div key={label} style={styles.flowItem}>
              <span style={styles.flowNumber}>{index + 1}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card title={t('panel.taskBoard')}>
        <p style={styles.muted}>在任务看板绑定工作区和权限，可手动执行或配置 cron；任务 Prompt 调用 qa_discover → qa_validate → qa_run → qa_report。</p>
        <button type="button" style={styles.button} onClick={() => { void copyPrompt() }}>
          {t('panel.copyPrompt')}
        </button>
        {copied && <span style={styles.copied}>{t('panel.copied')}</span>}
      </Card>
    </div>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={styles.card}>
      <h3 style={styles.cardTitle}>{title}</h3>
      {children}
    </section>
  )
}

function Pills({ values }: { values: string[] }) {
  return <div style={styles.pills}>{values.map(value => <span key={value} style={styles.pill}>{value}</span>)}</div>
}

const styles: Record<string, CSSProperties> = {
  container: { height: '100%', overflow: 'auto', padding: 24, color: 'var(--dsw-alias-label-primary, #e5e7eb)', background: 'var(--dsw-alias-bg-layer-1, #10131a)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 20 },
  title: { margin: 0, fontSize: 24 },
  subtitle: { margin: '8px 0 0', color: 'var(--dsw-alias-label-secondary, #9ca3af)', lineHeight: 1.6 },
  badge: { flexShrink: 0, padding: '6px 10px', borderRadius: 999, fontSize: 12 },
  badgeReady: { color: '#86efac', background: 'rgba(34,197,94,.14)' },
  badgeLoading: { color: '#fbbf24', background: 'rgba(245,158,11,.14)' },
  error: { padding: 12, marginBottom: 16, borderRadius: 8, color: '#fca5a5', background: 'rgba(239,68,68,.12)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 },
  card: { marginBottom: 14, padding: 18, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2, #303744)', background: 'var(--dsw-alias-bg-layer-2, #171b24)' },
  cardTitle: { margin: '0 0 14px', fontSize: 15 },
  pills: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  pill: { padding: '5px 9px', borderRadius: 999, fontSize: 12, color: '#bfdbfe', background: 'rgba(59,130,246,.14)' },
  code: { display: 'block', padding: 10, borderRadius: 8, color: '#93c5fd', background: 'rgba(0,0,0,.24)' },
  muted: { color: 'var(--dsw-alias-label-secondary, #9ca3af)', lineHeight: 1.7 },
  flow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 },
  flowItem: { display: 'flex', alignItems: 'center', gap: 9, padding: 10, borderRadius: 8, background: 'rgba(255,255,255,.035)', fontSize: 13 },
  flowNumber: { display: 'inline-grid', placeItems: 'center', width: 22, height: 22, borderRadius: 999, color: '#dbeafe', background: '#315aa8', fontWeight: 700 },
  button: { border: 0, borderRadius: 8, padding: '9px 14px', color: 'white', background: '#315aa8', cursor: 'pointer', fontWeight: 600 },
  copied: { marginLeft: 12, color: '#86efac', fontSize: 12 },
}
