# dsh-test-assistant 端到端 QA 自动化设计

## 目标

把 `dsh-test-assistant` 从单元测试命令包装器升级为运行在 DeepSeek Harness 内的端到端 QA 编排器。它面向 Java、Python、前端及其组合项目，负责：

1. 识别当前 Harness 会话的真实工作区和技术栈。
2. 启动或连接被测服务，等待健康检查，并在测试结束后回收本次启动的进程。
3. 在一个用例内串联浏览器、HTTP API、只读数据库、服务日志和项目测试命令。
4. 生成可审计的 JSON/Markdown 报告、覆盖率、通过率、失败证据和待修复问题。
5. 对账号、Token、数据库密码等敏感信息只接受环境变量引用，报告和日志统一脱敏。

本插件可以替代规则明确、可重复执行的回归 QA 工作；探索性测试、需求口径裁决和高风险生产验证仍需要人工决策。

## 支持矩阵

| 项目 | 自动探测 | 测试执行 | 服务生命周期 | 覆盖率 |
| --- | --- | --- | --- | --- |
| Java Maven | `pom.xml` | Maven Surefire/Failsafe | `mvn spring-boot:run` 或配置命令 | JaCoCo CSV/XML |
| Java Gradle | `build.gradle*` | Gradle `test` | `bootRun` 或配置命令 | JaCoCo CSV/XML |
| Python | `pyproject.toml`、`pytest.ini`、`requirements.txt` | pytest | Python/Uvicorn/Gunicorn/Flask/Django 配置命令 | `coverage.json` |
| 前端 | `package.json` | Vitest/Jest/npm script | npm/pnpm/yarn dev server 配置命令 | `coverage-summary.json` |
| 混合项目 | 多个子目录 | 按步骤分别执行 | 同一运行中编排多个服务 | 汇总各子项目覆盖率，不混淆口径 |

## 核心边界

### 工作区

所有相对路径必须基于 `exec.agent.session.header.cwd`，不能使用启动 Harness 时的 `process.cwd()`。配置文件默认位于：

```text
<workspace>/.dsh/qa.e2e.json
```

运行产物默认位于：

```text
<workspace>/.dsh/qa-runs/<run-id>/
  report.json
  report.md
  evidence/
```

### 凭据

配置中通过占位符引用凭据：

```text
${env:QA_USERNAME}
${env:QA_PASSWORD}
${env:QA_DB_PASSWORD}
${env:QA_LOG_TOKEN}
```

插件不持久化环境变量值，不把请求认证头、密码或 Token 写入报告。报告对名称包含 `PASSWORD`、`TOKEN`、`SECRET`、`KEY` 的环境变量值再次脱敏。

### 写操作

用例风险分为：

- `read`：查询、页面浏览、只读校验。
- `write`：创建或修改测试数据。
- `destructive`：删除、批量覆盖、不可逆操作。

`qa_run` 必须显式收到 `confirmWrite=true` 才执行 `write` 用例；`destructive` 还要求配置允许且调用时 `confirmDestructive=true`。数据库适配器无论如何只允许 `SELECT`、`WITH`、`SHOW`、`DESCRIBE`、`EXPLAIN`。

## 配置模型

```json
{
  "version": 1,
  "defaultEnvironment": "test",
  "artifactsDir": ".dsh/qa-runs",
  "requirements": [
    { "id": "REQ-LOGIN", "title": "用户可以登录", "risk": "critical" }
  ],
  "environments": {
    "test": {
      "baseUrl": "http://127.0.0.1:5173",
      "variables": { "vendorId": "1001" },
      "browser": {
        "channel": "chrome",
        "headless": true,
        "ignoreHTTPSErrors": false,
        "setup": [
          { "action": "goto", "url": "/login" },
          { "action": "fill", "selector": "[name=username]", "value": "${env:QA_USERNAME}" },
          { "action": "fill", "selector": "[name=password]", "value": "${env:QA_PASSWORD}" },
          { "action": "click", "selector": "button[type=submit]" },
          { "action": "waitFor", "selector": "[data-testid=home]" }
        ]
      },
      "database": {
        "type": "mysql",
        "hostEnv": "QA_DB_HOST",
        "port": 3306,
        "databaseEnv": "QA_DB_NAME",
        "userEnv": "QA_DB_USER",
        "passwordEnv": "QA_DB_PASSWORD"
      },
      "logs": {
        "order-service": {
          "type": "http",
          "url": "https://logs.example.internal/search",
          "method": "POST",
          "headers": { "Authorization": "Bearer ${env:QA_LOG_TOKEN}" },
          "queryField": "query"
        }
      },
      "services": {
        "backend": {
          "cwd": "backend",
          "command": ["mvn", "spring-boot:run"],
          "healthUrl": "http://127.0.0.1:8080/actuator/health",
          "startupTimeoutMs": 120000
        },
        "frontend": {
          "cwd": "frontend",
          "command": ["npm", "run", "dev", "--", "--host", "127.0.0.1"],
          "healthUrl": "http://127.0.0.1:5173",
          "startupTimeoutMs": 60000
        }
      }
    }
  },
  "suites": [
    {
      "id": "login-regression",
      "name": "登录回归",
      "cases": [
        {
          "id": "login-success",
          "name": "正常账号登录并核对登录日志",
          "risk": "read",
          "requirements": ["REQ-LOGIN"],
          "steps": [
            { "id": "backend", "type": "service.start", "service": "backend" },
            { "id": "frontend", "type": "service.start", "service": "frontend" },
            { "id": "home", "type": "ui", "action": "assertText", "selector": "h1", "text": "首页" },
            {
              "id": "profile-api",
              "type": "api",
              "method": "GET",
              "url": "/api/profile",
              "checks": [{ "path": "status", "operator": "eq", "expected": 200 }]
            },
            {
              "id": "account-db",
              "type": "db.query",
              "sql": "select status from account where username = ?",
              "params": ["${env:QA_USERNAME}"],
              "checks": [{ "path": "rows.0.status", "operator": "eq", "expected": "ACTIVE" }]
            },
            {
              "id": "login-log",
              "type": "log.query",
              "source": "order-service",
              "query": "username=${env:QA_USERNAME} AND event=LOGIN_SUCCESS",
              "checks": [{ "path": "body", "operator": "contains", "expected": "LOGIN_SUCCESS" }]
            }
          ]
        }
      ]
    }
  ]
}
```

## 步骤类型

### `service.start`

以参数数组启动 Java/Python/前端服务，不经过 shell 拼接；轮询健康检查。若端口上的服务已健康则复用，不归本次运行回收。插件只终止自己启动的进程。

### `project.test`

支持：

- `maven`：默认 `mvn test`。
- `gradle`：默认 `./gradlew test`。
- `pytest`：默认 `python -m pytest`。
- `vitest`：默认 `npx vitest run`。
- `jest`：默认 `npx jest`。
- `script`：显式参数数组，用于项目既有测试命令。

命令通过 `spawn(command, args, { shell: false })` 执行，继承调用信号并限制输出体积。

### `ui`

同一运行共享 Playwright BrowserContext，支持 `goto`、`fill`、`click`、`press`、`waitFor`、`assertText`、`assertUrl`、`screenshot`。失败时自动截图。

### `api`

使用 Node `fetch`，支持方法、请求头、JSON/文本 body 和统一断言。相对 URL 基于环境 `baseUrl`。

### `db.query`

首期原生支持 MySQL。只读 SQL 校验后使用参数化查询；返回行数和截断后的结果供断言，不记录密码。

### `log.query`

支持 HTTP 日志网关和本地文件尾部读取。HTTP 日志源可配置认证头和查询字段；结果进入统一断言与脱敏流程。

## 变量与步骤引用

- `${env:NAME}`：环境变量。
- `${vars:name}`：当前环境变量表。
- `${steps:stepId:path.to.value}`：前置步骤输出。
- `${workspace}`：当前会话工作区。
- `${runId}`：本次运行 ID。

缺失引用直接使步骤 `blocked`，不以空字符串继续。

## 报告口径

### 通过率

```text
通过率 = passed cases / executed cases
```

`blocked` 和 `skipped` 单独列出，不冒充通过。

### 覆盖率

- 需求覆盖率：被已执行用例关联的需求 / 配置中的全部需求。
- 用例覆盖率：已执行用例 / 本次筛选范围内全部用例。
- 步骤覆盖率：已执行步骤 / 本次筛选范围内全部步骤。
- 代码覆盖率：来自 JaCoCo、coverage.py、Vitest/Jest 的原生结果，按项目分别展示，不与需求覆盖率混合。

### 待修复问题

每个失败/阻塞步骤生成一条问题：严重级别、类别、用例、步骤、期望、实际、错误、证据路径和建议。插件只给证据驱动的初步建议，不将推断表述为已确认根因。

## Harness 工具

- `qa_discover`：识别 Java/Python/前端项目和可用配置。
- `qa_validate`：只读校验配置、环境变量、服务和步骤契约。
- `qa_run`：执行选定 suite/case/tag，生成报告。
- `qa_report`：读取最近一次或指定 run 的报告。
- `qa_task_template`：生成可直接填入任务看板的标题、说明和标准 Prompt。
- 保留 `test_run`、`test_gen`、`test_fix`，但全部改为使用调用会话工作区。

## 任务看板集成

当前 `@linxin666/dsh-client-ui-task-board` 已具备 Host 权威账本、工作区绑定、真实 Harness 会话执行和 cron 调度，因此测试助手不再实现第二套调度器。用户在任务看板新建任务时：

1. 选择被测项目对应工作区。
2. 使用 `qa_task_template` 生成的 Prompt，指定环境、suite/case/tag、测试用例文档路径和写操作确认边界。
3. 任务执行会话依次调用 `qa_discover`、`qa_validate`、`qa_run`、`qa_report`。
4. 任务详情和执行会话中保留报告路径、通过率、覆盖率和问题摘要；定时任务复用同一 Prompt。

任务看板的 `done/failed` 表示 Harness 任务会话是否正常结算，不天然等价于测试通过/失败。测试事实必须以 `qa_run` 报告的 `status` 为准；Prompt 要求 Agent 在测试失败时明确以失败结论收尾，不能把“执行完成”写成“测试通过”。如需让看板列状态严格跟随 QA 结果，需要任务看板上游增加结构化执行结果协议，本插件不直接修改第三方账本文件或绕过其 Host API。

测试用例文档支持两条路径：

- 已结构化：直接维护 `.dsh/qa.e2e.json`，这是执行事实源。
- 非结构化：任务 Prompt 指定 PRD、Markdown、CSV/Excel 等文档，Agent 先读取并生成/更新结构化配置，再调用 `qa_validate`。有业务口径歧义时必须阻塞并列出待确认项，不能猜测后直接执行写操作。

## 本轮验收标准

1. `npm run build`、类型检查和自动化测试通过。
2. Java/Python/前端项目探测均有测试。
3. 本地模拟系统至少跑通服务启动、API、浏览器、本地日志、报告闭环。
4. MySQL 适配器有只读 SQL 拦截测试；没有数据库时不伪造真实连接通过。
5. 报告包含需求/用例/步骤覆盖率、通过率和问题清单。
6. Harness 页面无插件加载错误，浏览器控制台无错误。
7. 不写入任何真实凭据，不连接未授权的公司系统。

## 后续扩展

- PostgreSQL、Oracle、ClickHouse 等数据库适配器。
- 公司日志平台专用适配器、单点登录和验证码人工接管。
- 测试数据准备/回滚事务、MQ 事件断言、链路追踪关联。
- CI/JUnit XML、Allure、飞书缺陷单等输出；外部写入必须单独授权。
