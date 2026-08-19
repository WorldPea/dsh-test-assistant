/**
 * Agent 工具定义：test_run / test_gen / test_fix。
 * 遵循 @deepseek-ai/dsh-tools 的 defineTool 规范。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TestFramework, TestRunResult, TestGenResult } from './runner.js'
import { detectFramework, runTests } from './runner.js'
import { isAbsolute, relative, resolve } from 'node:path'

/** 一个文本 content block */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** 格式化测试运行结果为可读文本 */
function renderTestRun(r: TestRunResult): string {
  const lines: string[] = [
    `框架: ${r.framework}`,
    `状态: ${r.passed ? '✅ 全部通过' : '❌ 存在失败'}`,
    `测试文件: ${r.numPassedSuites} 通过, ${r.numFailedSuites} 失败`,
    `测试用例: ${r.numPassedTests} 通过, ${r.numFailedTests} 失败, ${r.numSkippedTests} 跳过`,
    `耗时: ${r.durationMs}ms`,
  ]
  if (r.coverage >= 0) {
    lines.push(`覆盖率: ${r.coverage}%`)
  }
  if (r.failedFiles.length > 0) {
    lines.push(`失败文件:`)
    for (const f of r.failedFiles) {
      lines.push(`  ❌ ${f}`)
    }
  }
  if (r.stdout) {
    lines.push('', '--- 详细输出 ---', r.stdout)
  }
  if (r.stderr) {
    lines.push('', '--- 错误输出 ---', r.stderr)
  }
  return lines.join('\n')
}

// ─── test_run ────────────────────────────────────────────────

/**
 * 运行测试工具。Agent 调用时自动检测框架或手动指定。
 */
export function testRunTool() {
  return defineTool({
    name: 'test_run',
    description:
      '运行项目测试并返回结构化结果。自动检测 Jest、Vitest 或 pytest 框架。' +
      '触发词：运行测试、跑测试、test、单元测试、覆盖率、测试结果。',
    parameters: {
      path: {
        type: 'string',
        description: '可选，指定测试文件路径或目录。默认运行全部测试。',
      },
      framework: {
        type: 'string',
        enum: ['jest', 'vitest', 'pytest'],
        description: '可选，手动指定测试框架。默认自动检测。',
      },
      watch: {
        type: 'boolean',
        const: false, // watch 模式在 Agent 调用中无意义，固定为 false
        description: '不支持 watch 模式（Agent 调用中始终为 false）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          framework: { type: 'string', enum: ['jest', 'vitest', 'pytest', 'unknown'], required: true },
          passed: { type: 'boolean', required: true },
          numPassedSuites: { type: 'integer', required: true },
          numFailedSuites: { type: 'integer', required: true },
          numPassedTests: { type: 'integer', required: true },
          numFailedTests: { type: 'integer', required: true },
          numSkippedTests: { type: 'integer', required: true },
          durationMs: { type: 'integer', required: true },
          coverage: { type: 'number', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          failedFiles: { type: 'array', items: { type: 'string' }, required: true },
          exitCode: { type: 'integer', required: true },
        },
      },
      render: (_args: unknown, value: TestRunResult) => text(renderTestRun(value)),
    },
    async execute(args: { path?: string; framework?: TestFramework }, exec) {
      const workspaceRoot = exec.agent?.session.header.cwd
      if (workspaceRoot === undefined) throw new Error('test_run requires a Harness session with a workspace')
      return runTests({
        framework: args.framework as TestFramework | undefined,
        path: args.path,
        workspaceRoot,
      })
    },
  })
}

// ─── test_gen ────────────────────────────────────────────────

/**
 * 测试生成工具。告诉 Agent 为哪个文件/函数生成测试，Agent 会调用此工具
 * 生成测试文件框架，然后 Agent 可进一步用 str_replace_editor 编辑。
 */
export function testGenTool() {
  return defineTool({
    name: 'test_gen',
    description:
      '为指定的源文件生成测试文件框架。自动检测使用的测试框架，' +
      '生成对应的测试文件（含必要的 import 和 describe/it 或 test 块）。' +
      '触发词：生成测试、写测试、创建测试文件、add test。',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: '目标源文件路径（相对于项目根目录），如 src/utils.ts。',
      },
      framework: {
        type: 'string',
        enum: ['jest', 'vitest', 'pytest'],
        description: '可选，手动指定测试框架。默认自动检测。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          framework: { type: 'string', required: true },
          testFilePath: { type: 'string', required: true },
          targetFile: { type: 'string', required: true },
          exists: { type: 'boolean', required: true },
          skeleton: { type: 'string', required: true },
          hint: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: {
        framework: string
        testFilePath: string
        targetFile: string
        exists: boolean
        skeleton: string
        hint: string
      }) => {
        if (value.exists) {
          return text(`测试文件已存在: ${value.testFilePath}\n\n${value.hint}`)
        }
        return text([
          `框架: ${value.framework}`,
          `目标: ${value.targetFile}`,
          `测试文件: ${value.testFilePath}`,
          '',
          '--- 生成的测试骨架 ---',
          value.skeleton,
          '',
          value.hint,
        ].join('\n'))
      },
    },
    async execute(args: { target: string; framework?: string }, exec) {
      const workspaceRoot = exec.agent?.session.header.cwd
      if (workspaceRoot === undefined) throw new Error('test_gen requires a Harness session with a workspace')
      const target = safeRelativePath(workspaceRoot, args.target)
      const framework = (args.framework as TestFramework) ?? detectFramework(workspaceRoot)
      const { testFilePath, skeleton } = generateTestSkeleton(target, framework)

      const { existsSync } = await import('node:fs')
      const exists = existsSync(resolve(workspaceRoot, testFilePath))

      return {
        framework,
        testFilePath,
        targetFile: target,
        exists,
        skeleton,
        hint: exists
          ? '测试文件已存在。请用 str_replace_editor 编辑现有文件，补充新的测试用例。'
          : '请用 write 工具将 skeleton 写入测试文件，然后根据源文件内容补充具体的测试用例。',
      }
    },
  })
}

/** 生成测试文件骨架 */
function generateTestSkeleton(target: string, framework: TestFramework): {
  testFilePath: string
  skeleton: string
} {
  // 计算测试文件路径
  const ext = target.split('.').pop() ?? 'ts'
  const baseName = target.replace(/\.[^.]+$/, '')
  const testSuffix = ext === 'ts' || ext === 'tsx' ? '.test.ts' : ext === 'js' || ext === 'jsx' ? '.test.js' : '.test.ts'

  let testFilePath: string
  if (target.startsWith('src/')) {
    testFilePath = `src/__tests__/${baseName.replace('src/', '')}${testSuffix}`
  } else {
    testFilePath = `${baseName}${testSuffix}`
  }

  const importName = baseName.replace(/^.*[/\\]/, '')
  const importPath = testFilePath.includes('__tests__')
    ? target.replace('src/', '../').replace(/\.\w+$/, '')
    : `./${target.replace(/\.\w+$/, '')}`

  switch (framework) {
    case 'jest':
    case 'vitest':
      return {
        testFilePath,
        skeleton: [
          `import { describe, it, expect } from '${framework === 'vitest' ? 'vitest' : '@jest/globals'}'`,
          `// TODO: 从源文件导入需要测试的函数/类`,
          `// import { ${importName} } from '${importPath}'`,
          '',
          `describe('${importName}', () => {`,
          `  it('should work correctly', () => {`,
          `    // TODO: 编写测试逻辑`,
          `    expect(true).toBe(true)`,
          `  })`,
          '',
          `  it('should handle edge cases', () => {`,
          `    // TODO: 边界条件测试`,
          `    expect(true).toBe(true)`,
          `  })`,
          '',
          `  it('should handle errors gracefully', () => {`,
          `    // TODO: 错误处理测试`,
          `    expect(true).toBe(true)`,
          `  })`,
          `})`,
        ].join('\n'),
      }

    case 'pytest': {
      testFilePath = `tests/test_${importName}.py`
      return {
        testFilePath,
        skeleton: [
          `import pytest`,
          `# TODO: 从目标模块导入`,
          `# from ${importName} import ...`,
          '',
          `class Test${importName.charAt(0).toUpperCase() + importName.slice(1)}:`,
          `    def test_basic(self):`,
          `        """基本功能测试"""`,
          `        # TODO: 编写测试逻辑`,
          `        assert True`,
          '',
          `    def test_edge_cases(self):`,
          `        """边界条件测试"""`,
          `        assert True`,
          '',
          `    def test_error_handling(self):`,
          `        """错误处理测试"""`,
          `        with pytest.raises(ValueError):`,
          `            pass  # TODO: 替换为实际调用`,
        ].join('\n'),
      }
    }

    default:
      return {
        testFilePath: `${baseName}.test.ts`,
        skeleton: `// 未检测到测试框架，已生成通用测试骨架\n// 请安装 Jest 或 Vitest\n\ndescribe('${importName}', () => {\n  it('should work', () => {\n    expect(true).toBe(true)\n  })\n})`,
      }
  }
}

// ─── test_fix ────────────────────────────────────────────────

/**
 * 测试修复工具。运行测试后，对失败的测试文件进行分析，
 * 返回失败原因摘要，Agent 再据此修复代码。
 */
export function testFixTool() {
  return defineTool({
    name: 'test_fix',
    description:
      '分析失败的测试，返回每个失败用例的错误信息和堆栈。' +
      'Agent 根据返回的分析结果，用 str_replace_editor 修复测试代码或被测代码。' +
      '触发词：修复测试、fix test、测试失败、debug test。',
    parameters: {
      path: {
        type: 'string',
        description: '可选，指定要分析的测试文件路径。默认分析所有失败的测试。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          framework: { type: 'string', required: true },
          totalFailed: { type: 'integer', required: true },
          failures: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                testName: { type: 'string', required: true },
                message: { type: 'string', required: true },
                suggestion: { type: 'string', required: true },
              },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: {
        framework: string
        totalFailed: number
        failures: Array<{ file: string; testName: string; message: string; suggestion: string }>
        summary: string
      }) => {
        if (value.totalFailed === 0) {
          return text('没有失败的测试。')
        }
        const lines = [
          `框架: ${value.framework}`,
          `失败数: ${value.totalFailed}`,
          '',
        ]
        for (const f of value.failures) {
          lines.push(`❌ ${f.testName}`)
          lines.push(`   文件: ${f.file}`)
          lines.push(`   错误: ${f.message}`)
          lines.push(`   建议: ${f.suggestion}`)
          lines.push('')
        }
        lines.push(value.summary)
        return text(lines.join('\n'))
      },
    },
    async execute(args: { path?: string }, exec) {
      const workspaceRoot = exec.agent?.session.header.cwd
      if (workspaceRoot === undefined) throw new Error('test_fix requires a Harness session with a workspace')
      const result = await runTests({ path: args.path, workspaceRoot })
      const failures: Array<{
        file: string
        testName: string
        message: string
        suggestion: string
      }> = []

      if (result.failedFiles.length === 0) {
        return {
          framework: result.framework,
          totalFailed: 0,
          failures: [],
          summary: '所有测试通过，无需修复。',
        }
      }

      // 分析 stdout 中的失败信息
      const lines = result.stdout.split('\n')
      let currentFile = ''
      let currentTest = ''
      let currentMessage: string[] = []
      let inFailure = false

      for (const line of lines) {
        // Jest/Vitest 格式: ● test name
        if (line.trim().startsWith('● ')) {
          if (inFailure && currentTest) {
            failures.push({
              file: currentFile,
              testName: currentTest,
              message: currentMessage.slice(0, 5).join('\n'),
              suggestion: suggestFix(currentMessage.join('\n')),
            })
          }
          currentTest = line.trim().replace('● ', '')
          currentMessage = []
          inFailure = true
        }
        // FAIL 文件标记
        else if (line.startsWith('FAIL ')) {
          currentFile = line.replace('FAIL ', '').trim()
        }
        // pytest 格式: FAILED test_file.py::TestClass::test_name
        else if (line.startsWith('FAILED ')) {
          const parts = line.replace('FAILED ', '').trim()
          const [file, ...testParts] = parts.split('::')
          currentFile = file
          currentTest = testParts.join('::')
          currentMessage = []
          inFailure = true
        }
        // 收集错误信息
        else if (inFailure && line.trim()) {
          currentMessage.push(line)
        }
        // 空行结束一个失败块
        else if (inFailure && !line.trim()) {
          if (currentTest) {
            failures.push({
              file: currentFile,
              testName: currentTest,
              message: currentMessage.slice(0, 5).join('\n'),
              suggestion: suggestFix(currentMessage.join('\n')),
            })
          }
          inFailure = false
          currentTest = ''
          currentMessage = []
        }
      }

      // 最后一个失败块
      if (inFailure && currentTest) {
        failures.push({
          file: currentFile,
          testName: currentTest,
          message: currentMessage.slice(0, 5).join('\n'),
          suggestion: suggestFix(currentMessage.join('\n')),
        })
      }

      return {
        framework: result.framework,
        totalFailed: failures.length,
        failures,
        summary: `共 ${failures.length} 个失败用例。请根据上面的错误信息修复代码，然后用 test_run 验证修复结果。`,
      }
    },
  })
}

function safeRelativePath(workspaceRoot: string, value: string): string {
  const target = isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value)
  const rel = relative(resolve(workspaceRoot), target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`target escapes workspace: ${value}`)
  return rel
}

/**
 * 根据错误信息推断修复建议（简单启发式）。
 */
function suggestFix(errorText: string): string {
  const lower = errorText.toLowerCase()
  if (lower.includes('cannot find module') || lower.includes('module not found')) {
    return '检查 import 路径是否正确，或包是否已安装。'
  }
  if (lower.includes('is not a function')) {
    return '检查函数导出（export）是否正确，或函数名是否拼写正确。'
  }
  if (lower.includes('expected') && (lower.includes('received') || lower.includes('to be'))) {
    return '断言不匹配：检查被测函数的返回值是否与预期一致。'
  }
  if (lower.includes('typeerror') || lower.includes('cannot read property')) {
    return '类型错误：检查变量是否为 null/undefined，或对象属性是否存在。'
  }
  if (lower.includes('timeout') || lower.includes('exceeded')) {
    return '测试超时：检查是否有异步操作未正确等待，或增加 timeout 值。'
  }
  if (lower.includes('undefined')) {
    return '变量未定义：检查是否遗漏了 import 或初始化。'
  }
  return '查看错误信息，检查对应的代码逻辑。'
}
