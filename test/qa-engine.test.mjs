import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import test from 'node:test'
import {
  discoverQaWorkspace,
  qaEngineInternals,
  runQaPlan,
  validateQaConfig,
} from '../lib/qa.js'
import { createWorkbenchConfig, readWorkbenchSnapshot, saveWorkbenchConfig } from '../lib/workbench.js'

test('discovers Java Maven, Java Gradle, Python, and frontend projects', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-qa-discovery-'))
  for (const dir of ['maven', 'gradle', 'python', 'frontend']) mkdirSync(join(root, dir))
  writeFileSync(join(root, 'maven', 'pom.xml'), '<project/>')
  writeFileSync(join(root, 'gradle', 'build.gradle.kts'), 'plugins {}')
  writeFileSync(join(root, 'python', 'pyproject.toml'), '[tool.pytest.ini_options]\n')
  writeFileSync(join(root, 'frontend', 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }))

  const kinds = discoverQaWorkspace(root).projects.map(project => project.kind)

  assert.deepEqual(new Set(kinds), new Set(['java-maven', 'java-gradle', 'python', 'frontend']))
})

test('configuration validation reports missing credential environment variables', () => {
  const result = validateQaConfig({
    version: 1,
    environments: {
      test: { browser: { setup: [{ action: 'fill', selector: '#password', value: '${env:DSH_QA_TEST_MISSING_PASSWORD}' }] } },
    },
    suites: [{ id: 's', name: 'suite', cases: [{ id: 'c', name: 'case', steps: [{ id: 'a', type: 'api', url: 'http://127.0.0.1' }] }] }],
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.missingEnvironmentVariables, ['DSH_QA_TEST_MISSING_PASSWORD'])
})

test('database guard accepts reads and rejects writes', () => {
  assert.doesNotThrow(() => { qaEngineInternals.assertReadOnlySql('select status from account where id = ?') })
  assert.doesNotThrow(() => { qaEngineInternals.assertReadOnlySql('with x as (select 1) select * from x') })
  assert.throws(() => { qaEngineInternals.assertReadOnlySql('update account set status = 0') }, /allows only/)
  assert.throws(() => { qaEngineInternals.assertReadOnlySql('select 1; delete from account') }, /one statement/)
})

test('maps Java, Python, and frontend frameworks to safe argv commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-qa-commands-'))
  writeFileSync(join(root, 'mvnw'), '')
  writeFileSync(join(root, 'gradlew'), '')
  assert.deepEqual(qaEngineInternals.defaultTestCommand('maven', root), ['./mvnw', 'test'])
  assert.deepEqual(qaEngineInternals.defaultTestCommand('gradle', root, 'ExampleTest'), ['./gradlew', 'test', '--tests', 'ExampleTest'])
  assert.deepEqual(qaEngineInternals.defaultTestCommand('pytest', root, 'tests/test_api.py'), ['python', '-m', 'pytest', 'tests/test_api.py'])
  assert.deepEqual(qaEngineInternals.defaultTestCommand('vitest', root), ['npx', 'vitest', 'run'])
  assert.deepEqual(qaEngineInternals.defaultTestCommand('jest', root), ['npx', 'jest'])
})

test('workbench scaffolds a valid config and saves it atomically with backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-qa-workbench-'))
  writeFileSync(join(root, 'pom.xml'), '<project/>')
  mkdirSync(join(root, 'java-module'))
  mkdirSync(join(root, 'frontend'))
  writeFileSync(join(root, 'java-module', 'pom.xml'), '<project/>')
  writeFileSync(join(root, 'frontend', 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }))
  const discovery = discoverQaWorkspace(root)
  const config = createWorkbenchConfig(discovery, {
    environment: 'test',
    baseUrl: 'http://127.0.0.1:5173',
    browser: true,
    login: {
      enabled: true,
      loginUrl: '/login',
      usernameSelector: '#username',
      usernameEnv: 'QA_USERNAME',
      passwordSelector: '#password',
      passwordEnv: 'QA_PASSWORD',
      submitSelector: '#login',
      successSelector: '#home',
    },
  })

  assert.equal(validateQaConfig(config).valid, true)
  assert.equal(config.suites.some(suite => suite.id === 'project-regression'), true)
  assert.equal(config.suites.some(suite => suite.id === 'browser-smoke'), true)
  assert.equal(config.suites.find(suite => suite.id === 'project-regression')?.cases.length, 2)
  const first = saveWorkbenchConfig(root, config)
  assert.equal(first.configExists, true)
  assert.equal(first.validation?.valid, true)
  config.artifactsDir = '.dsh/custom-runs'
  saveWorkbenchConfig(root, config)
  assert.equal(existsSync(join(root, '.dsh', 'qa.e2e.json.bak')), true)
  assert.equal(readWorkbenchSnapshot(root).config?.artifactsDir, '.dsh/custom-runs')
})

test('runs service, browser, API, project command, local logs, and writes report', {
  skip: !existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-qa-e2e-'))
  const port = await freePort()
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, 'app.log'), 'INFO boot\nINFO LOGIN_SUCCESS username=qa\n')
  writeFileSync(join(root, 'mock-server.mjs'), mockServerSource())
  const config = {
    version: 1,
    defaultEnvironment: 'test',
    requirements: [{ id: 'REQ-LOGIN', title: 'login works', risk: 'critical' }],
    environments: {
      test: {
        baseUrl: `http://127.0.0.1:${port}`,
        browser: {
          executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          headless: true,
          setup: [
            { action: 'goto', url: '/login' },
            { action: 'fill', selector: '#username', value: 'qa' },
            { action: 'fill', selector: '#password', value: 'secret' },
            { action: 'click', selector: '#login' },
            { action: 'waitFor', selector: '#home' },
          ],
        },
        services: {
          app: {
            command: [process.execPath, join(root, 'mock-server.mjs'), String(port)],
            healthUrl: `http://127.0.0.1:${port}/health`,
            startupTimeoutMs: 10000,
          },
        },
        logs: { app: { type: 'file', path: 'app.log' } },
      },
    },
    suites: [{
      id: 'login', name: 'login', cases: [{
        id: 'login-ok', name: 'login success', risk: 'read', requirements: ['REQ-LOGIN'], steps: [
          { id: 'service', type: 'service.start', service: 'app' },
          { id: 'project-test', type: 'project.test', framework: 'script', command: [process.execPath, '-e', 'console.log("project tests passed")'] },
          { id: 'ui', type: 'ui', action: 'assertText', selector: '#home', text: 'Welcome qa' },
          { id: 'api', type: 'api', method: 'GET', url: '/api/profile', useBrowserSession: true, checks: [{ path: 'json.user', operator: 'eq', expected: 'qa' }] },
          { id: 'log', type: 'log.query', source: 'app', query: 'LOGIN_SUCCESS', checks: [{ path: 'body', operator: 'contains', expected: 'username=qa' }] },
          { id: 'shot', type: 'ui', action: 'screenshot', name: 'home' },
        ],
      }],
    }],
  }
  writeFileSync(join(root, '.dsh', 'qa.e2e.json'), JSON.stringify(config, null, 2))

  const report = await runQaPlan({ workspace: root })

  assert.equal(report.status, 'passed')
  assert.equal(report.passRate.percent, 100)
  assert.equal(report.coverage.requirements.percent, 100)
  assert.equal(report.coverage.cases.percent, 100)
  assert.equal(report.coverage.steps.percent, 100)
  assert.equal(report.issues.length, 0)
  assert.equal(existsSync(report.artifacts.json), true)
  assert.equal(existsSync(report.artifacts.markdown), true)
  assert.match(readFileSync(report.artifacts.markdown, 'utf8'), /通过率：100%/)
})

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(error => { error ? reject(error) : resolve(port) })
    })
  })
}

function mockServerSource() {
  return `import http from 'node:http'
const port = Number(process.argv[2])
const page = '<!doctype html><html><body><form id="form"><input id="username"><input id="password" type="password"><button id="login">Login</button></form><script>form.addEventListener("submit",e=>{e.preventDefault();document.cookie="session=ok; path=/";document.body.innerHTML="<h1 id=home>Welcome qa</h1>"})</script></body></html>'
http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200).end('ok');return}
  if(req.url==='/api/profile'){if(!String(req.headers.cookie||'').includes('session=ok')){res.writeHead(401).end('unauthorized');return}res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({user:'qa'}));return}
  res.writeHead(200,{'content-type':'text/html'}).end(page)
}).listen(port,'127.0.0.1')
`
}
