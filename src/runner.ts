/**
 * 测试运行器：自动检测项目测试框架并执行测试。
 * 支持 Jest、Vitest（JS/TS）、pytest（Python）。
 */
import { execSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cwd } from 'node:process'

/** 支持的测试框架 */
export type TestFramework = 'jest' | 'vitest' | 'pytest' | 'unknown'

/** 一次测试运行的结果 */
export interface TestRunResult {
  /** 框架名称 */
  framework: TestFramework
  /** 是否全部通过 */
  passed: boolean
  /** 通过的测试套件数 */
  numPassedSuites: number
  /** 失败的测试套件数 */
  numFailedSuites: number
  /** 通过的测试用例数 */
  numPassedTests: number
  /** 失败的测试用例数 */
  numFailedTests: number
  /** 跳过的测试用例数 */
  numSkippedTests: number
  /** 总耗时（毫秒） */
  durationMs: number
  /** 覆盖率（0-100），未启用覆盖率为 -1 */
  coverage: number
  /** 原始 stdout */
  stdout: string
  /** 原始 stderr */
  stderr: string
  /** 失败的测试文件列表 */
  failedFiles: string[]
  /** 退出码 */
  exitCode: number
}

/** 测试文件生成结果 */
export interface TestGenResult {
  /** 生成的测试文件路径 */
  filePath: string
  /** 目标源文件 */
  sourceFile: string
  /** 生成的测试代码 */
  code: string
}

/**
 * 检测当前项目使用的测试框架。
 * 按优先级检查：package.json → 配置文件 → 目录惯例。
 */
export function detectFramework(workspaceRoot?: string): TestFramework {
  const root = workspaceRoot ?? cwd()
  const pkgJson = resolve(root, 'package.json')
  const pyproject = resolve(root, 'pyproject.toml')

  // JS/TS 项目：检查 package.json
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8'))
      const deps = { ...pkg.devDependencies, ...pkg.dependencies }

      if (deps.vitest) return 'vitest'
      if (deps.jest || deps['@jest/globals']) return 'jest'

      // 检查 scripts
      const scripts = pkg.scripts ?? {}
      if (Object.values(scripts).some((s: unknown) => String(s).includes('vitest'))) return 'vitest'
      if (Object.values(scripts).some((s: unknown) => String(s).includes('jest'))) return 'jest'
    } catch { /* ignore */ }
  }

  // 检查配置文件
  if (existsSync(resolve(root, 'vitest.config.ts')) || existsSync(resolve(root, 'vitest.config.js'))) return 'vitest'
  if (existsSync(resolve(root, 'jest.config.ts')) || existsSync(resolve(root, 'jest.config.js')) || existsSync(resolve(root, 'jest.config.mjs'))) return 'jest'

  // Python 项目
  if (existsSync(pyproject)) {
    try {
      const content = readFileSync(pyproject, 'utf-8')
      if (content.includes('pytest')) return 'pytest'
    } catch { /* ignore */ }
  }
  if (existsSync(resolve(root, 'pytest.ini')) || existsSync(resolve(root, 'tox.ini'))) return 'pytest'

  return 'unknown'
}

/**
 * 运行测试并返回结构化结果。
 */
export async function runTests(options: {
  framework?: TestFramework
  path?: string
  watch?: boolean
  workspaceRoot?: string
}): Promise<TestRunResult> {
  const root = options.workspaceRoot ?? cwd()
  const framework = options.framework ?? detectFramework(root)

  switch (framework) {
    case 'jest': return runJest(root, options.path)
    case 'vitest': return runVitest(root, options.path)
    case 'pytest': return runPytest(root, options.path)
    default:
      return {
        framework: 'unknown',
        passed: false,
        numPassedSuites: 0, numFailedSuites: 0,
        numPassedTests: 0, numFailedTests: 0, numSkippedTests: 0,
        durationMs: 0, coverage: -1,
        stdout: '', stderr: '未检测到测试框架。请安装 Jest、Vitest 或 pytest。',
        failedFiles: [], exitCode: -1,
      }
  }
}

/** 运行 Jest 测试 */
async function runJest(root: string, path?: string): Promise<TestRunResult> {
  const args = ['npx', 'jest', '--json', '--verbose', '--no-color']
  if (path) args.push(path)

  try {
    const start = Date.now()
    const stdout = execSync(args.join(' '), { cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
    const durationMs = Date.now() - start

    const json = JSON.parse(stdout)
    return {
      framework: 'jest',
      passed: json.success,
      numPassedSuites: json.numPassedTestSuites ?? 0,
      numFailedSuites: json.numFailedTestSuites ?? 0,
      numPassedTests: json.numPassedTests ?? 0,
      numFailedTests: json.numFailedTests ?? 0,
      numSkippedTests: (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0),
      durationMs,
      coverage: extractCoverageFromJest(json),
      stdout: formatJestOutput(json),
      stderr: '',
      failedFiles: (json.testResults ?? [])
        .filter((r: any) => r.status === 'failed')
        .map((r: any) => r.name),
      exitCode: json.success ? 0 : 1,
    }
  } catch (err: any) {
    // Jest 返回非零退出码但 stdout 可能仍有 JSON
    if (err.stdout) {
      try {
        const json = JSON.parse(err.stdout)
        const durationMs = Date.now() - (err.duration ?? 0)
        return {
          framework: 'jest',
          passed: false,
          numPassedSuites: json.numPassedTestSuites ?? 0,
          numFailedSuites: json.numFailedTestSuites ?? 0,
          numPassedTests: json.numPassedTests ?? 0,
          numFailedTests: json.numFailedTests ?? 0,
          numSkippedTests: (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0),
          durationMs,
          coverage: extractCoverageFromJest(json),
          stdout: formatJestOutput(json),
          stderr: err.stderr ?? '',
          failedFiles: (json.testResults ?? [])
            .filter((r: any) => r.status === 'failed')
            .map((r: any) => r.name),
          exitCode: 1,
        }
      } catch { /* fall through */ }
    }
    return {
      framework: 'jest',
      passed: false,
      numPassedSuites: 0, numFailedSuites: 0,
      numPassedTests: 0, numFailedTests: 0, numSkippedTests: 0,
      durationMs: 0, coverage: -1,
      stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '',
      failedFiles: [], exitCode: 1,
    }
  }
}

/** 运行 Vitest 测试 */
async function runVitest(root: string, path?: string): Promise<TestRunResult> {
  const args = ['npx', 'vitest', 'run', '--reporter=json', '--no-color']
  if (path) args.push(path)

  try {
    const start = Date.now()
    const stdout = execSync(args.join(' '), { cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
    const durationMs = Date.now() - start

    // Vitest JSON reporter 输出可能包含非 JSON 前缀
    const jsonStr = stdout.substring(stdout.indexOf('{'))
    const json = JSON.parse(jsonStr)

    const testResults = json.testResults ?? []
    const passed = testResults.every((r: any) => r.status === 'passed')
    const numPassed = testResults.filter((r: any) => r.status === 'passed').length
    const numFailed = testResults.filter((r: any) => r.status === 'failed').length
    const numPassedTests = testResults.reduce((sum: number, r: any) => {
      return sum + (r.assertionResults?.filter((a: any) => a.status === 'passed').length ?? 0)
    }, 0)
    const numFailedTests = testResults.reduce((sum: number, r: any) => {
      return sum + (r.assertionResults?.filter((a: any) => a.status === 'failed').length ?? 0)
    }, 0)
    const numSkippedTests = testResults.reduce((sum: number, r: any) => {
      return sum + (r.assertionResults?.filter((a: any) => a.status === 'skipped' || a.status === 'pending').length ?? 0)
    }, 0)

    return {
      framework: 'vitest',
      passed,
      numPassedSuites: numPassed,
      numFailedSuites: numFailed,
      numPassedTests,
      numFailedTests,
      numSkippedTests,
      durationMs,
      coverage: json.coverageMap ? extractCoverageFromVitest(json) : -1,
      stdout: formatVitestOutput(json),
      stderr: '',
      failedFiles: testResults.filter((r: any) => r.status === 'failed').map((r: any) => r.name),
      exitCode: passed ? 0 : 1,
    }
  } catch (err: any) {
    if (err.stdout) {
      try {
        const jsonStr = err.stdout.substring(err.stdout.indexOf('{'))
        const json = JSON.parse(jsonStr)
        const testResults = json.testResults ?? []
        return {
          framework: 'vitest',
          passed: false,
          numPassedSuites: testResults.filter((r: any) => r.status === 'passed').length,
          numFailedSuites: testResults.filter((r: any) => r.status === 'failed').length,
          numPassedTests: testResults.reduce((s: number, r: any) => s + (r.assertionResults?.filter((a: any) => a.status === 'passed').length ?? 0), 0),
          numFailedTests: testResults.reduce((s: number, r: any) => s + (r.assertionResults?.filter((a: any) => a.status === 'failed').length ?? 0), 0),
          numSkippedTests: 0,
          durationMs: 0,
          coverage: -1,
          stdout: formatVitestOutput(json),
          stderr: err.stderr ?? '',
          failedFiles: testResults.filter((r: any) => r.status === 'failed').map((r: any) => r.name),
          exitCode: 1,
        }
      } catch { /* fall through */ }
    }
    return {
      framework: 'vitest',
      passed: false,
      numPassedSuites: 0, numFailedSuites: 0,
      numPassedTests: 0, numFailedTests: 0, numSkippedTests: 0,
      durationMs: 0, coverage: -1,
      stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '',
      failedFiles: [], exitCode: 1,
    }
  }
}

/** 运行 pytest */
async function runPytest(root: string, path?: string): Promise<TestRunResult> {
  const args = ['python3', '-m', 'pytest', '-v', '--tb=short', '--no-header']
  if (path) args.push(path)

  try {
    const start = Date.now()
    const stdout = execSync(args.join(' '), { cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
    const durationMs = Date.now() - start
    return parsePytestOutput(stdout, durationMs)
  } catch (err: any) {
    const stdout = err.stdout ?? ''
    const stderr = err.stderr ?? ''
    return parsePytestOutput(stdout + '\n' + stderr, 0, true)
  }
}

/** 解析 pytest 文本输出 */
function parsePytestOutput(output: string, durationMs: number, failed = false): TestRunResult {
  const passedMatch = output.match(/(\d+)\s+passed/)
  const failedMatch = output.match(/(\d+)\s+failed/)
  const skippedMatch = output.match(/(\d+)\s+skipped/)
  const errorMatch = output.match(/(\d+)\s+errors?/)

  const numPassed = passedMatch ? parseInt(passedMatch[1]) : 0
  const numFailed = (failedMatch ? parseInt(failedMatch[1]) : 0) + (errorMatch ? parseInt(errorMatch[1]) : 0)
  const numSkipped = skippedMatch ? parseInt(skippedMatch[1]) : 0

  // 提取失败的测试文件
  const failedFiles: string[] = []
  const lines = output.split('\n')
  for (const line of lines) {
    if (line.startsWith('FAILED ')) {
      const filePath = line.replace('FAILED ', '').trim().split('::')[0]
      if (filePath && !failedFiles.includes(filePath)) failedFiles.push(filePath)
    }
  }

  return {
    framework: 'pytest',
    passed: !failed && numFailed === 0,
    numPassedSuites: numPassed > 0 ? 1 : 0,
    numFailedSuites: numFailed > 0 ? 1 : 0,
    numPassedTests: numPassed,
    numFailedTests: numFailed,
    numSkippedTests: numSkipped,
    durationMs,
    coverage: -1,
    stdout: output,
    stderr: '',
    failedFiles,
    exitCode: numFailed > 0 ? 1 : 0,
  }
}

/** 从 Jest JSON 输出中提取覆盖率 */
function extractCoverageFromJest(json: any): number {
  const coverageMap = json.coverageMap
  if (!coverageMap) return -1
  const files = Object.values(coverageMap) as any[]
  if (files.length === 0) return -1
  const totalPct = files.reduce((sum, f: any) => sum + (f.lines?.pct ?? 0), 0) / files.length
  return Math.round(totalPct * 10) / 10
}

/** 从 Vitest JSON 输出中提取覆盖率 */
function extractCoverageFromVitest(json: any): number {
  const coverageMap = json.coverageMap
  if (!coverageMap) return -1
  const files = Object.values(coverageMap) as any[]
  if (files.length === 0) return -1
  const totalPct = files.reduce((sum, f: any) => sum + (f.lines?.pct ?? 0), 0) / files.length
  return Math.round(totalPct * 10) / 10
}

/** 格式化 Jest 输出为可读摘要 */
function formatJestOutput(json: any): string {
  const lines: string[] = []
  lines.push(`测试套件: ${json.numPassedTestSuites ?? 0} 通过, ${json.numFailedTestSuites ?? 0} 失败, ${json.numTotalTestSuites ?? 0} 总计`)
  lines.push(`测试用例: ${json.numPassedTests ?? 0} 通过, ${json.numFailedTests ?? 0} 失败, ${json.numTotalTests ?? 0} 总计`)
  lines.push(`耗时: ${json.startTime ? '...' : '完成'}`)

  const results = json.testResults ?? []
  for (const result of results) {
    const status = result.status === 'passed' ? '✅' : '❌'
    const name = result.name.replace(/^.*[/\\]/, '')
    lines.push(`${status} ${name}`)
    if (result.status === 'failed') {
      for (const msg of (result.message ?? '').split('\n').slice(0, 5)) {
        lines.push(`    ${msg}`)
      }
    }
  }
  return lines.join('\n')
}

/** 格式化 Vitest 输出为可读摘要 */
function formatVitestOutput(json: any): string {
  const lines: string[] = []
  const results = json.testResults ?? []
  const passed = results.filter((r: any) => r.status === 'passed').length
  const failed = results.filter((r: any) => r.status === 'failed').length
  lines.push(`测试文件: ${passed} 通过, ${failed} 失败, ${results.length} 总计`)
  lines.push(`耗时: ${json.endTime ? `${(json.endTime - json.startTime) / 1000}s` : '完成'}`)

  for (const result of results) {
    const status = result.status === 'passed' ? '✅' : '❌'
    const name = result.name.replace(/^.*[/\\]/, '')
    lines.push(`${status} ${name}`)

    const assertions = result.assertionResults ?? []
    for (const a of assertions) {
      const icon = a.status === 'passed' ? '  ✓' : a.status === 'failed' ? '  ✗' : '  ○'
      lines.push(`${icon} ${a.title}`)
      if (a.status === 'failed' && a.failureMessages) {
        for (const msg of (a.failureMessages[0] ?? '').split('\n').slice(0, 3)) {
          lines.push(`      ${msg}`)
        }
      }
    }
  }
  return lines.join('\n')
}