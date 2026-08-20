# dsh-test-assistant

运行在 DeepSeek Harness 中的端到端 QA 自动化插件。它以当前 Harness 会话工作区为边界，编排 Java、Python、前端项目测试、服务生命周期、Playwright 页面操作、HTTP API、只读 MySQL 和服务日志，并输出覆盖率、通过率、失败证据和待修复问题。

## 安装

```bash
git clone https://github.com/WorldPea/dsh-test-assistant.git
cd dsh-test-assistant
pnpm install
pnpm build
dsh plugin --profile web add link:$(pwd)
```

重启 `dsh web` 后，在会话中使用 `qa_discover`、`qa_validate`、`qa_run`、`qa_report`，或者从“端到端 QA”页签复制任务看板 Prompt。

## 能力

- Java：Maven/Gradle、Spring Boot 服务、JaCoCo 报告。
- Python：pytest、可配置 Web 服务、coverage.py 报告。
- 前端：Vitest/Jest、dev server、Playwright Chrome 页面操作。
- 跨层验证：页面登录后复用 Cookie 调 API，再查只读 DB 和服务日志。
- 报告：需求/用例/步骤覆盖率、各项目代码覆盖率、用例通过率、截图和问题清单。
- 任务看板：生成标准 Prompt，可绑定工作区、权限并通过 cron 定时执行。

## 工作区配置

优先在 Harness 会话的“端到端 QA”页签使用工作台向导。工作台会：

1. 自动识别 Java Maven/Gradle、Python 和前端子项目。
2. 引导配置页面/API 地址、登录选择器、DB 与日志环境变量引用。
3. 自动生成、校验并原子保存配置；覆盖旧配置时保留 `.bak`。
4. 展示测试用例，直接执行只读测试并查看报告。

工作台最终仍在被测项目维护同一份事实配置：

```text
.dsh/qa.e2e.json
```

可从 [`examples/qa.e2e.example.json`](examples/qa.e2e.example.json) 开始。完整设计见 [`docs/e2e-qa-assistant-design.md`](docs/e2e-qa-assistant-design.md)。

工作台 Host API 只接受 loopback 请求，并使用当前会话 `sessionId` 在 Host 端解析工作区；浏览器不能传入任意本机路径。

### 项目发现口径

工作台不会展示工作区的所有目录。它默认向下扫描 3 层，只识别含 `pom.xml`、`build.gradle*`、Python 项目标志或 `package.json` 的技术项目。界面按应用分组：Maven/Gradle 聚合项目显示为一张顶层卡片，同类型子模块折叠在卡片内；独立前端、Python 项目保留为单独卡片。默认选择顶层应用，只有需要单独运行某个子模块时才展开勾选。

敏感值只使用环境变量：

```json
{
  "value": "${env:QA_PASSWORD}"
}
```

报告默认写入 `.dsh/qa-runs/<run-id>/`。建议在业务仓库 `.gitignore` 中忽略 `.dsh/qa-runs/`。

## Harness 工具

| 工具 | 用途 |
| --- | --- |
| `qa_discover` | 识别 Java/Python/前端项目和配置。 |
| `qa_validate` | 只读校验配置和环境变量。 |
| `qa_run` | 执行端到端流程并生成报告。 |
| `qa_report` | 读取最近一次或指定运行报告。 |
| `qa_task_template` | 生成任务看板标准 Prompt。 |

原有 `test_run`、`test_gen`、`test_fix` 保留，并改为使用调用会话的工作区。

## 页面操作

`ui` 步骤支持：

- `goto`
- `fill`
- `click`
- `press`
- `waitFor`
- `assertText`
- `assertUrl`
- `screenshot`

环境 `browser.setup` 可完成一次登录；后续 UI 步骤共享 BrowserContext。API 步骤设置 `useBrowserSession: true` 后会复用登录 Cookie。

验证码、短信、人脸和企业 SSO 二次确认不会被绕过，应当作为人工接管点或使用测试环境专用认证方案。

## 任务看板

在任务看板中新建任务并选择被测工作区。可以先在会话中调用：

```text
qa_task_template
```

将返回的 Prompt 填入任务。任务看板负责独立会话和 cron 调度；测试助手负责结构化执行与报告。任务卡“已完成”只说明 Harness 会话正常结束，测试事实以 `qa_run.status` 为准。

## 安全边界

- `write` 用例要求 `confirmWrite=true`。
- `destructive` 用例还要求配置 `allowDestructive=true` 和 `confirmDestructive=true`。
- MySQL 适配器只接受 `SELECT/WITH/SHOW/DESCRIBE/EXPLAIN`，使用参数化查询并设置只读事务。
- 服务和测试命令使用参数数组与 `shell:false`。
- 环境变量中的密码、Token、Secret、Key 会在报告中脱敏。
- 插件不会自动创建外部缺陷单、修改公司系统或绕过登录安全措施。

## 开发验证

```bash
npm run typecheck
npm test
```

自动化测试包含 Java/Python/前端探测、数据库只读拦截，以及一个真实 Chrome 登录页面的完整本地 E2E 闭环。
