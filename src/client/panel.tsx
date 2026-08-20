import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { QaConfig, QaDetectedProject, QaRunReport } from '../qa/types.js'
import type { TestKey } from './locales.js'

type Translate = (key: TestKey) => string
type Tab = 'overview' | 'setup' | 'cases' | 'report'

export interface TestPanelProps {
  t: Translate
  sessionId: string
}

interface WorkbenchSnapshot {
  workspace: string
  configPath: string
  configExists: boolean
  discovery: { projects: QaDetectedProject[] }
  config?: QaConfig
  validation?: {
    valid: boolean
    errors: string[]
    warnings: string[]
    missingEnvironmentVariables: string[]
  }
  latestReport?: QaRunReport
}

interface SetupForm {
  environment: string
  baseUrl: string
  browser: boolean
  login: boolean
  loginUrl: string
  usernameSelector: string
  usernameEnv: string
  passwordSelector: string
  passwordEnv: string
  submitSelector: string
  successSelector: string
  database: boolean
  dbHostEnv: string
  dbPort: string
  dbNameEnv: string
  dbUserEnv: string
  dbPasswordEnv: string
  logs: boolean
  logUrl: string
  logTokenEnv: string
}

const DEFAULT_FORM: SetupForm = {
  environment: 'test', baseUrl: '', browser: false, login: false, loginUrl: '/login',
  usernameSelector: '[name=username]', usernameEnv: 'QA_USERNAME',
  passwordSelector: '[name=password]', passwordEnv: 'QA_PASSWORD',
  submitSelector: 'button[type=submit]', successSelector: '', database: false,
  dbHostEnv: 'QA_DB_HOST', dbPort: '3306', dbNameEnv: 'QA_DB_NAME',
  dbUserEnv: 'QA_DB_USER', dbPasswordEnv: 'QA_DB_PASSWORD', logs: false,
  logUrl: '', logTokenEnv: 'QA_LOG_TOKEN',
}

const TASK_PROMPT = `执行本工作区的端到端 QA 自动化任务。
1. 调用 qa_discover 和 qa_validate；配置或环境不完整时输出阻塞清单。
2. 调用 qa_run；未经用户确认不得执行 write/destructive 用例。
3. 调用 qa_report，汇总通过率、覆盖率、证据和待修复问题。
4. qa_run.status 不是 passed 时，必须明确写测试失败或被阻塞。`

export function TestPanel({ t, sessionId }: TestPanelProps) {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [form, setForm] = useState<SetupForm>(DEFAULT_FORM)
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set())
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set())
  const [confirmWrite, setConfirmWrite] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = async (): Promise<void> => {
    setError('')
    const value = await request<WorkbenchSnapshot>(`/api/dsh-test-assistant/workbench?sessionId=${encodeURIComponent(sessionId)}`)
    setSnapshot(value)
  }

  useEffect(() => { void refresh().catch(cause => { setError(message(cause)) }) }, [sessionId])
  useEffect(() => {
    if (snapshot === null) return
    setSelectedProjects(defaultProjectKeys(snapshot.discovery.projects))
    const ids = snapshot.config?.suites.flatMap(suite => suite.cases.map(testCase => testCase.id)) ?? []
    setSelectedCases(new Set(ids))
    if (snapshot.config !== undefined) setForm(formFromConfig(snapshot.config))
  }, [snapshot])

  const cases = useMemo(
    () => snapshot?.config?.suites.flatMap(suite => suite.cases.map(testCase => ({ suite: suite.name, ...testCase }))) ?? [],
    [snapshot?.config],
  )

  const perform = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label); setError(''); setNotice('')
    try { await action() } catch (cause) { setError(message(cause)) } finally { setBusy('') }
  }

  const scaffold = async (): Promise<void> => perform('正在生成配置…', async () => {
    if (snapshot?.configExists && !window.confirm('重新生成会覆盖当前配置，并保留 .bak 备份。继续吗？')) return
    const value = await request<WorkbenchSnapshot>('/api/dsh-test-assistant/workbench/scaffold', {
      method: 'POST',
      body: JSON.stringify({ sessionId, input: scaffoldInput(form, selectedProjects) }),
    })
    setSnapshot(value); setNotice('配置已生成并保存'); setTab('cases')
  })

  const saveConnections = async (): Promise<void> => perform('正在保存连接配置…', async () => {
    if (snapshot?.config === undefined) return scaffold()
    const config = applyConnections(structuredClone(snapshot.config), form)
    const value = await request<WorkbenchSnapshot>('/api/dsh-test-assistant/workbench/config', {
      method: 'PUT', body: JSON.stringify({ sessionId, config }),
    })
    setSnapshot(value); setNotice('连接配置已保存并通过结构校验')
  })

  const run = async (): Promise<void> => perform('正在执行端到端测试…', async () => {
    const report = await request<QaRunReport>('/api/dsh-test-assistant/workbench/run', {
      method: 'POST',
      body: JSON.stringify({ sessionId, environment: form.environment, caseIds: [...selectedCases], confirmWrite }),
    })
    await refresh()
    setSnapshot(current => current === null ? current : { ...current, latestReport: report })
    setTab('report')
    setNotice(report.status === 'passed' ? '测试通过' : report.status === 'failed' ? '测试失败，请查看问题清单' : '测试被阻塞')
  })

  const copyPrompt = async (): Promise<void> => {
    await navigator.clipboard.writeText(TASK_PROMPT)
    setNotice('任务 Prompt 已复制')
  }

  const readiness = snapshot?.validation
  const ready = snapshot?.configExists === true && readiness?.valid === true && readiness.missingEnvironmentVariables.length === 0

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div>
          <h2 style={styles.title}>{t('panel.title')}</h2>
          <p style={styles.subtitle}>{snapshot?.workspace ?? t('panel.loading')}</p>
        </div>
        <span style={{ ...styles.badge, ...(ready ? styles.badgeReady : styles.badgeWarning) }}>
          {ready ? '环境就绪' : snapshot === null ? '加载中' : '需要配置'}
        </span>
      </header>

      <nav style={styles.tabs}>
        {([['overview', '总览'], ['setup', '环境向导'], ['cases', '测试用例'], ['report', '运行报告']] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} type="button" style={{ ...styles.tab, ...(tab === id ? styles.tabActive : {}) }} onClick={() => { setTab(id) }}>{label}</button>
        ))}
      </nav>

      {busy && <div style={styles.busy}>{busy}</div>}
      {error && <div style={styles.error}>{error}</div>}
      {notice && <div style={styles.notice}>{notice}</div>}

      {tab === 'overview' && <Overview snapshot={snapshot} onSetup={() => { setTab('setup') }} onCopy={() => { void copyPrompt() }} />}
      {tab === 'setup' && <Setup
        snapshot={snapshot} form={form} setForm={setForm} selected={selectedProjects}
        toggleProject={key => { setSelectedProjects(toggle(selectedProjects, key)) }}
        onScaffold={() => { void scaffold() }} onSave={() => { void saveConnections() }}
      />}
      {tab === 'cases' && <Cases
        cases={cases} selected={selectedCases} setSelected={setSelectedCases}
        ready={ready} confirmWrite={confirmWrite} setConfirmWrite={setConfirmWrite}
        onRun={() => { void run() }}
      />}
      {tab === 'report' && <Report report={snapshot?.latestReport} />}
    </div>
  )
}

function Overview({ snapshot, onSetup, onCopy }: { snapshot: WorkbenchSnapshot | null; onSetup(): void; onCopy(): void }) {
  const validation = snapshot?.validation
  return <>
    <section style={styles.grid}>
      <Metric label="识别项目" value={String(snapshot?.discovery.projects.length ?? 0)} ok={(snapshot?.discovery.projects.length ?? 0) > 0} />
      <Metric label="QA 配置" value={snapshot?.configExists ? '已创建' : '未创建'} ok={snapshot?.configExists === true} />
      <Metric label="配置校验" value={validation?.valid ? '通过' : '未通过'} ok={validation?.valid === true} />
      <Metric label="环境变量" value={validation ? `${validation.missingEnvironmentVariables.length} 项缺失` : '待校验'} ok={validation?.missingEnvironmentVariables.length === 0} />
    </section>
    {(validation?.errors.length ?? 0) > 0 && <Card title="配置错误"><List values={validation!.errors} tone="error" /></Card>}
    {(validation?.missingEnvironmentVariables.length ?? 0) > 0 && <Card title="缺失环境变量"><Pills values={validation!.missingEnvironmentVariables} /></Card>}
    <Card title="下一步">
      <button type="button" style={styles.button} onClick={onSetup}>{snapshot?.configExists ? '完善环境配置' : '开始配置向导'}</button>
      <button type="button" style={styles.secondaryButton} onClick={onCopy}>复制任务看板 Prompt</button>
    </Card>
  </>
}

function Setup(props: {
  snapshot: WorkbenchSnapshot | null; form: SetupForm; setForm(value: SetupForm): void
  selected: Set<string>; toggleProject(key: string): void; onScaffold(): void; onSave(): void
}) {
  const { snapshot, form } = props
  const set = <K extends keyof SetupForm>(key: K, value: SetupForm[K]): void => props.setForm({ ...form, [key]: value })
  return <>
    <Card title="1. 选择项目">
      {snapshot?.discovery.projects.length === 0 && <p style={styles.muted}>未识别到 Maven、Gradle、Python 或前端项目。</p>}
      <div style={styles.projectList}>{snapshot?.discovery.projects.map(project => {
        const key = projectKey(project)
        return <label key={key} style={styles.checkRow}><input type="checkbox" checked={props.selected.has(key)} onChange={() => { props.toggleProject(key) }} /><span><b>{project.path}</b><small>{project.kind} · {project.framework}</small></span></label>
      })}</div>
    </Card>
    <Card title="2. 测试环境">
      <div style={styles.formGrid}>
        <Field label="环境名称" value={form.environment} onChange={value => { set('environment', value) }} />
        <Field label="页面/API 基础地址" value={form.baseUrl} placeholder="https://test.example.com" onChange={value => { set('baseUrl', value) }} />
      </div>
    </Card>
    <Card title="3. 页面登录">
      <Toggle label="启用 Chrome 页面测试" checked={form.browser} onChange={value => { set('browser', value) }} />
      {form.browser && <>
        <Toggle label="需要登录" checked={form.login} onChange={value => { set('login', value) }} />
        {form.login && <div style={styles.formGrid}>
          <Field label="登录路径" value={form.loginUrl} onChange={value => { set('loginUrl', value) }} />
          <Field label="登录成功元素" value={form.successSelector} placeholder="[data-testid=home]" onChange={value => { set('successSelector', value) }} />
          <Field label="账号选择器" value={form.usernameSelector} onChange={value => { set('usernameSelector', value) }} />
          <Field label="账号环境变量" value={form.usernameEnv} onChange={value => { set('usernameEnv', value) }} />
          <Field label="密码选择器" value={form.passwordSelector} onChange={value => { set('passwordSelector', value) }} />
          <Field label="密码环境变量" value={form.passwordEnv} onChange={value => { set('passwordEnv', value) }} />
          <Field label="登录按钮选择器" value={form.submitSelector} onChange={value => { set('submitSelector', value) }} />
        </div>}
      </>}
    </Card>
    <Card title="4. 数据库与日志">
      <Toggle label="启用 MySQL 只读校验" checked={form.database} onChange={value => { set('database', value) }} />
      {form.database && <div style={styles.formGrid}>
        <Field label="Host 环境变量" value={form.dbHostEnv} onChange={value => { set('dbHostEnv', value) }} />
        <Field label="端口" value={form.dbPort} onChange={value => { set('dbPort', value) }} />
        <Field label="库名环境变量" value={form.dbNameEnv} onChange={value => { set('dbNameEnv', value) }} />
        <Field label="用户环境变量" value={form.dbUserEnv} onChange={value => { set('dbUserEnv', value) }} />
        <Field label="密码环境变量" value={form.dbPasswordEnv} onChange={value => { set('dbPasswordEnv', value) }} />
      </div>}
      <Toggle label="启用 HTTP 日志平台" checked={form.logs} onChange={value => { set('logs', value) }} />
      {form.logs && <div style={styles.formGrid}>
        <Field label="日志查询地址" value={form.logUrl} onChange={value => { set('logUrl', value) }} />
        <Field label="Token 环境变量" value={form.logTokenEnv} onChange={value => { set('logTokenEnv', value) }} />
      </div>}
    </Card>
    <div style={styles.actions}>
      {!snapshot?.configExists && <button type="button" style={styles.button} onClick={props.onScaffold}>生成配置</button>}
      {snapshot?.configExists && <button type="button" style={styles.button} onClick={props.onSave}>保存连接配置</button>}
      {snapshot?.configExists && <button type="button" style={styles.dangerButton} onClick={props.onScaffold}>重新生成全部配置</button>}
    </div>
  </>
}

function Cases(props: {
  cases: Array<{ suite: string; id: string; name: string; risk?: string; steps: unknown[] }>
  selected: Set<string>; setSelected(value: Set<string>): void; ready: boolean
  confirmWrite: boolean; setConfirmWrite(value: boolean): void; onRun(): void
}) {
  return <Card title="测试用例">
    {props.cases.length === 0 && <p style={styles.muted}>请先通过环境向导生成配置。</p>}
    {props.cases.map(testCase => <label key={testCase.id} style={styles.caseRow}>
      <input type="checkbox" checked={props.selected.has(testCase.id)} onChange={() => { props.setSelected(toggle(props.selected, testCase.id)) }} />
      <span style={styles.caseMain}><b>{testCase.name}</b><small>{testCase.suite} · {testCase.steps.length} 步骤</small></span>
      <span style={testCase.risk === 'read' || testCase.risk === undefined ? styles.readBadge : styles.writeBadge}>{testCase.risk ?? 'read'}</span>
    </label>)}
    <Toggle label="我已确认允许执行 write 用例" checked={props.confirmWrite} onChange={props.setConfirmWrite} />
    <button type="button" style={styles.button} disabled={!props.ready || props.selected.size === 0} onClick={props.onRun}>执行选中用例</button>
    {!props.ready && <p style={styles.warning}>配置校验或环境变量尚未就绪，暂不能执行。</p>}
  </Card>
}

function Report({ report }: { report?: QaRunReport }) {
  if (report === undefined) return <Card title="运行报告"><p style={styles.muted}>尚无运行记录。</p></Card>
  return <>
    <section style={styles.grid}>
      <Metric label="状态" value={report.status} ok={report.status === 'passed'} />
      <Metric label="通过率" value={`${report.passRate.percent}%`} ok={report.status === 'passed'} />
      <Metric label="用例覆盖率" value={`${report.coverage.cases.percent}%`} ok={report.coverage.cases.percent === 100} />
      <Metric label="待修复问题" value={String(report.issues.length)} ok={report.issues.length === 0} />
    </section>
    <Card title="用例结果">{report.cases.map(testCase => <div key={testCase.id} style={styles.resultRow}><b>{icon(testCase.status)} {testCase.name}</b><span>{testCase.durationMs}ms</span></div>)}</Card>
    <Card title="待修复问题">{report.issues.length === 0 ? <p style={styles.success}>没有检测到问题。</p> : report.issues.map(issue => <div key={issue.id} style={styles.issue}><b>{issue.id} [{issue.severity}] {issue.title}</b><span>{issue.error ?? issue.suggestion}</span></div>)}</Card>
    <Card title="报告文件"><code style={styles.code}>{report.artifacts.markdown}</code></Card>
  </>
}

function Metric({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return <div style={styles.metric}><span>{label}</span><b style={ok ? styles.success : styles.warning}>{value}</b></div>
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section style={styles.card}><h3 style={styles.cardTitle}>{title}</h3>{children}</section>
}

function Field({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange(value: string): void }) {
  return <label style={styles.field}><span>{label}</span><input style={styles.input} value={value} placeholder={placeholder} onChange={event => { onChange(event.target.value) }} /></label>
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <label style={styles.toggle}><input type="checkbox" checked={checked} onChange={event => { onChange(event.target.checked) }} /><span>{label}</span></label>
}

function Pills({ values }: { values: string[] }) { return <div style={styles.pills}>{values.map(value => <span key={value} style={styles.pill}>{value}</span>)}</div> }
function List({ values, tone }: { values: string[]; tone: 'error' }) { return <ul style={tone === 'error' ? styles.errorList : undefined}>{values.map(value => <li key={value}>{value}</li>)}</ul> }

function scaffoldInput(form: SetupForm, projects: Set<string>) {
  return {
    environment: form.environment, baseUrl: form.baseUrl, includeProjects: [...projects], browser: form.browser,
    login: { enabled: form.login, loginUrl: form.loginUrl, usernameSelector: form.usernameSelector, usernameEnv: form.usernameEnv, passwordSelector: form.passwordSelector, passwordEnv: form.passwordEnv, submitSelector: form.submitSelector, successSelector: form.successSelector },
    database: { enabled: form.database, hostEnv: form.dbHostEnv, port: Number(form.dbPort) || 3306, databaseEnv: form.dbNameEnv, userEnv: form.dbUserEnv, passwordEnv: form.dbPasswordEnv },
    logs: { enabled: form.logs, url: form.logUrl, tokenEnv: form.logTokenEnv },
  }
}

function applyConnections(config: QaConfig, form: SetupForm): QaConfig {
  config.defaultEnvironment = form.environment
  const environment = config.environments[form.environment] ?? {}
  environment.baseUrl = form.baseUrl || undefined
  if (form.browser) {
    const setup: any[] = []
    if (form.login) {
      setup.push({ action: 'goto', url: form.loginUrl || '/login' })
      if (form.usernameSelector && form.usernameEnv) setup.push({ action: 'fill', selector: form.usernameSelector, value: `\${env:${form.usernameEnv}}` })
      if (form.passwordSelector && form.passwordEnv) setup.push({ action: 'fill', selector: form.passwordSelector, value: `\${env:${form.passwordEnv}}` })
      if (form.submitSelector) setup.push({ action: 'click', selector: form.submitSelector })
      if (form.successSelector) setup.push({ action: 'waitFor', selector: form.successSelector })
    }
    environment.browser = { channel: 'chrome', headless: true, setup }
  } else delete environment.browser
  if (form.database) environment.database = { type: 'mysql', hostEnv: form.dbHostEnv, port: Number(form.dbPort) || 3306, databaseEnv: form.dbNameEnv, userEnv: form.dbUserEnv, passwordEnv: form.dbPasswordEnv, maxRows: 100 }
  else delete environment.database
  if (form.logs && form.logUrl) environment.logs = { application: { type: 'http', url: form.logUrl, method: 'POST', headers: { Authorization: `Bearer \${env:${form.logTokenEnv}}` }, queryField: 'query' } }
  else delete environment.logs
  config.environments[form.environment] = environment
  return config
}

function formFromConfig(config: QaConfig): SetupForm {
  const name = config.defaultEnvironment ?? Object.keys(config.environments)[0] ?? 'test'
  const env = config.environments[name] ?? {}
  const setup = env.browser?.setup ?? []
  const valueFor = (action: string, field: 'selector' | 'url' | 'value'): string => String((setup.find(item => item.action === action) as any)?.[field] ?? '')
  const envName = (value: string, fallback: string): string => value.match(/^\$\{env:([^}]+)\}$/)?.[1] ?? fallback
  const log = env.logs?.application?.type === 'http' ? env.logs.application : undefined
  const auth = log?.headers?.Authorization ?? ''
  return {
    ...DEFAULT_FORM, environment: name, baseUrl: env.baseUrl ?? '', browser: env.browser !== undefined,
    login: setup.length > 0, loginUrl: valueFor('goto', 'url') || '/login',
    usernameSelector: valueFor('fill', 'selector') || DEFAULT_FORM.usernameSelector,
    usernameEnv: envName(valueFor('fill', 'value'), 'QA_USERNAME'),
    passwordSelector: String((setup.filter(item => item.action === 'fill')[1] as any)?.selector ?? DEFAULT_FORM.passwordSelector),
    passwordEnv: envName(String((setup.filter(item => item.action === 'fill')[1] as any)?.value ?? ''), 'QA_PASSWORD'),
    submitSelector: valueFor('click', 'selector') || DEFAULT_FORM.submitSelector,
    successSelector: valueFor('waitFor', 'selector'), database: env.database !== undefined,
    dbHostEnv: env.database?.hostEnv ?? DEFAULT_FORM.dbHostEnv, dbPort: String(env.database?.port ?? 3306),
    dbNameEnv: env.database?.databaseEnv ?? DEFAULT_FORM.dbNameEnv, dbUserEnv: env.database?.userEnv ?? DEFAULT_FORM.dbUserEnv,
    dbPasswordEnv: env.database?.passwordEnv ?? DEFAULT_FORM.dbPasswordEnv, logs: log !== undefined,
    logUrl: log?.url ?? '', logTokenEnv: auth.match(/\$\{env:([^}]+)\}/)?.[1] ?? 'QA_LOG_TOKEN',
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const value = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}

function toggle(values: Set<string>, key: string): Set<string> { const next = new Set(values); next.has(key) ? next.delete(key) : next.add(key); return next }
function projectKey(project: QaDetectedProject): string { return `${project.kind}:${project.path}` }
function defaultProjectKeys(projects: QaDetectedProject[]): Set<string> {
  const sorted = [...projects].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
  const selected: QaDetectedProject[] = []
  for (const project of sorted) {
    if (selected.some(parent => parent.kind === project.kind && (parent.path === '.' || project.path.startsWith(`${parent.path}/`)))) continue
    selected.push(project)
  }
  return new Set(selected.map(projectKey))
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function icon(status: string): string { return status === 'passed' ? '✅' : status === 'failed' ? '❌' : status === 'blocked' ? '⛔' : '⏭️' }

const styles: Record<string, CSSProperties> = {
  container: { height: '100%', overflow: 'auto', padding: 24, color: 'var(--dsw-alias-label-primary, #e5e7eb)', background: 'var(--dsw-alias-bg-layer-1, #10131a)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }, title: { margin: 0, fontSize: 24 }, subtitle: { margin: '7px 0 0', maxWidth: 760, color: 'var(--dsw-alias-label-secondary, #9ca3af)', wordBreak: 'break-all' },
  badge: { flexShrink: 0, padding: '6px 11px', borderRadius: 999, fontSize: 12 }, badgeReady: { color: '#86efac', background: 'rgba(34,197,94,.14)' }, badgeWarning: { color: '#fbbf24', background: 'rgba(245,158,11,.14)' },
  tabs: { display: 'flex', gap: 6, marginBottom: 18, padding: 4, borderRadius: 10, background: 'rgba(255,255,255,.04)' }, tab: { border: 0, padding: '8px 13px', borderRadius: 7, color: '#9ca3af', background: 'transparent', cursor: 'pointer' }, tabActive: { color: '#fff', background: '#315aa8' },
  busy: { padding: 10, marginBottom: 12, borderRadius: 8, color: '#bfdbfe', background: 'rgba(59,130,246,.12)' }, error: { padding: 11, marginBottom: 12, borderRadius: 8, color: '#fca5a5', background: 'rgba(239,68,68,.12)' }, notice: { padding: 11, marginBottom: 12, borderRadius: 8, color: '#86efac', background: 'rgba(34,197,94,.12)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }, metric: { display: 'flex', flexDirection: 'column', gap: 8, padding: 16, borderRadius: 11, border: '1px solid var(--dsw-alias-border-l2, #303744)', background: 'var(--dsw-alias-bg-layer-2, #171b24)' },
  card: { marginBottom: 14, padding: 18, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2, #303744)', background: 'var(--dsw-alias-bg-layer-2, #171b24)' }, cardTitle: { margin: '0 0 14px', fontSize: 15 },
  projectList: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 8 }, checkRow: { display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8, background: 'rgba(255,255,255,.035)' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, margin: '12px 0' }, field: { display: 'flex', flexDirection: 'column', gap: 6, color: '#cbd5e1', fontSize: 12 }, input: { padding: '9px 10px', border: '1px solid #374151', borderRadius: 7, color: '#e5e7eb', background: '#111827' },
  toggle: { display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', cursor: 'pointer' }, actions: { display: 'flex', gap: 10, marginBottom: 18 }, button: { border: 0, borderRadius: 8, padding: '9px 14px', color: 'white', background: '#315aa8', cursor: 'pointer', fontWeight: 600 }, secondaryButton: { marginLeft: 10, border: '1px solid #4b5563', borderRadius: 8, padding: '8px 13px', color: '#d1d5db', background: 'transparent', cursor: 'pointer' }, dangerButton: { border: '1px solid #ef4444', borderRadius: 8, padding: '8px 13px', color: '#fca5a5', background: 'transparent', cursor: 'pointer' },
  caseRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '11px 4px', borderBottom: '1px solid rgba(255,255,255,.06)' }, caseMain: { display: 'flex', flex: 1, flexDirection: 'column', gap: 4 }, readBadge: { padding: '3px 7px', borderRadius: 999, color: '#86efac', background: 'rgba(34,197,94,.12)', fontSize: 11 }, writeBadge: { padding: '3px 7px', borderRadius: 999, color: '#fbbf24', background: 'rgba(245,158,11,.12)', fontSize: 11 },
  resultRow: { display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid rgba(255,255,255,.06)' }, issue: { display: 'flex', flexDirection: 'column', gap: 5, padding: '10px 0', color: '#fca5a5', borderBottom: '1px solid rgba(255,255,255,.06)' },
  code: { display: 'block', padding: 10, borderRadius: 8, color: '#93c5fd', background: 'rgba(0,0,0,.24)', overflowWrap: 'anywhere' }, muted: { color: '#9ca3af', lineHeight: 1.6 }, warning: { color: '#fbbf24' }, success: { color: '#86efac' }, pills: { display: 'flex', flexWrap: 'wrap', gap: 7 }, pill: { padding: '4px 8px', borderRadius: 999, color: '#bfdbfe', background: 'rgba(59,130,246,.14)', fontSize: 12 }, errorList: { color: '#fca5a5', lineHeight: 1.7 },
}
