import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { QaConfig, QaEnvironment, QaStep } from './types.js'

export const DEFAULT_QA_CONFIG = '.dsh/qa.e2e.json'

export interface QaValidationResult {
  valid: boolean
  configPath: string
  errors: string[]
  warnings: string[]
  missingEnvironmentVariables: string[]
  config?: QaConfig
}

export function resolveConfigPath(workspace: string, requested?: string): string {
  const value = requested ?? DEFAULT_QA_CONFIG
  return isAbsolute(value) ? value : resolve(workspace, value)
}

export function loadQaConfig(workspace: string, requested?: string): QaConfig {
  const configPath = resolveConfigPath(workspace, requested)
  if (!existsSync(configPath)) throw new Error(`QA config not found: ${configPath}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (cause) {
    throw new Error(`QA config is not valid JSON: ${configPath}: ${errorMessage(cause)}`)
  }
  const validation = validateQaConfig(parsed, configPath)
  if (!validation.valid || validation.config === undefined) {
    throw new Error(`QA config validation failed:\n${validation.errors.map(error => `- ${error}`).join('\n')}`)
  }
  return validation.config
}

export function validateQaConfig(value: unknown, configPath = '<memory>'): QaValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const missing = new Set<string>()
  const root = asRecord(value)
  if (root === undefined) {
    return { valid: false, configPath, errors: ['root must be an object'], warnings, missingEnvironmentVariables: [] }
  }
  if (root.version !== 1) errors.push('version must be 1')
  const environments = asRecord(root.environments)
  if (environments === undefined || Object.keys(environments).length === 0) errors.push('environments must be a non-empty object')
  const suites = Array.isArray(root.suites) ? root.suites : undefined
  if (suites === undefined || suites.length === 0) errors.push('suites must be a non-empty array')

  const envNames = new Set(Object.keys(environments ?? {}))
  if (typeof root.defaultEnvironment === 'string' && !envNames.has(root.defaultEnvironment)) {
    errors.push(`defaultEnvironment references missing environment "${root.defaultEnvironment}"`)
  }

  for (const [name, raw] of Object.entries(environments ?? {})) {
    validateEnvironment(name, raw, errors, missing)
    collectEnvRefs(raw, missing)
  }

  const suiteIds = new Set<string>()
  const caseIds = new Set<string>()
  for (const [suiteIndex, rawSuite] of (suites ?? []).entries()) {
    const suite = asRecord(rawSuite)
    if (suite === undefined) {
      errors.push(`suites[${suiteIndex}] must be an object`)
      continue
    }
    const suiteId = requiredString(suite.id, `suites[${suiteIndex}].id`, errors)
    requiredString(suite.name, `suites[${suiteIndex}].name`, errors)
    if (suiteId !== undefined && suiteIds.has(suiteId)) errors.push(`duplicate suite id "${suiteId}"`)
    if (suiteId !== undefined) suiteIds.add(suiteId)
    if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
      errors.push(`suite "${suiteId ?? suiteIndex}" must contain cases`)
      continue
    }
    for (const [caseIndex, rawCase] of suite.cases.entries()) {
      const testCase = asRecord(rawCase)
      if (testCase === undefined) {
        errors.push(`suite "${suiteId}" cases[${caseIndex}] must be an object`)
        continue
      }
      const caseId = requiredString(testCase.id, `case[${caseIndex}].id`, errors)
      requiredString(testCase.name, `case "${caseId}".name`, errors)
      if (caseId !== undefined && caseIds.has(caseId)) errors.push(`duplicate case id "${caseId}"`)
      if (caseId !== undefined) caseIds.add(caseId)
      if (testCase.risk !== undefined && !['read', 'write', 'destructive'].includes(String(testCase.risk))) {
        errors.push(`case "${caseId}" risk must be read, write, or destructive`)
      }
      if (!Array.isArray(testCase.steps) || testCase.steps.length === 0) {
        errors.push(`case "${caseId}" must contain steps`)
        continue
      }
      const stepIds = new Set<string>()
      for (const [stepIndex, rawStep] of testCase.steps.entries()) {
        const step = asRecord(rawStep)
        if (step === undefined) {
          errors.push(`case "${caseId}" steps[${stepIndex}] must be an object`)
          continue
        }
        const stepId = requiredString(step.id, `case "${caseId}" steps[${stepIndex}].id`, errors)
        const type = requiredString(step.type, `step "${stepId}".type`, errors)
        if (stepId !== undefined && stepIds.has(stepId)) errors.push(`duplicate step id "${stepId}" in case "${caseId}"`)
        if (stepId !== undefined) stepIds.add(stepId)
        if (type !== undefined && !['service.start', 'project.test', 'ui', 'api', 'db.query', 'log.query'].includes(type)) {
          errors.push(`step "${stepId}" has unsupported type "${type}"`)
        }
        validateStep(step as unknown as QaStep, `step "${stepId}"`, errors)
        collectEnvRefs(step, missing)
      }
    }
  }

  const requirements = Array.isArray(root.requirements) ? root.requirements : []
  const requirementIds = new Set<string>()
  for (const raw of requirements) {
    const requirement = asRecord(raw)
    if (requirement === undefined || typeof requirement.id !== 'string') continue
    if (requirementIds.has(requirement.id)) errors.push(`duplicate requirement id "${requirement.id}"`)
    requirementIds.add(requirement.id)
  }
  for (const rawSuite of suites ?? []) {
    const suite = asRecord(rawSuite)
    if (!Array.isArray(suite?.cases)) continue
    for (const rawCase of suite.cases) {
      const testCase = asRecord(rawCase)
      if (!Array.isArray(testCase?.requirements)) continue
      for (const requirement of testCase.requirements) {
        if (typeof requirement === 'string' && !requirementIds.has(requirement)) {
          warnings.push(`case "${String(testCase.id)}" references undeclared requirement "${requirement}"`)
        }
      }
    }
  }

  for (const name of [...missing]) {
    if (process.env[name] !== undefined) missing.delete(name)
  }
  return {
    valid: errors.length === 0,
    configPath,
    errors,
    warnings,
    missingEnvironmentVariables: [...missing].sort(),
    ...(errors.length === 0 ? { config: root as unknown as QaConfig } : {}),
  }
}

function validateEnvironment(name: string, value: unknown, errors: string[], missing: Set<string>): void {
  const env = asRecord(value) as unknown as QaEnvironment | undefined
  if (env === undefined) {
    errors.push(`environment "${name}" must be an object`)
    return
  }
  if (env.database !== undefined) {
    const db = asRecord(env.database)
    if (db?.type !== 'mysql') errors.push(`environment "${name}" database.type must be mysql`)
    for (const key of ['hostEnv', 'databaseEnv', 'userEnv', 'passwordEnv']) {
      if (typeof db?.[key] !== 'string') errors.push(`environment "${name}" database.${key} is required`)
      else if (process.env[db[key]] === undefined) missing.add(db[key])
    }
  }
  for (const [serviceName, rawService] of Object.entries(env.services ?? {})) {
    const service = asRecord(rawService)
    if (!Array.isArray(service?.command) || service.command.some(part => typeof part !== 'string')) {
      errors.push(`environment "${name}" service "${serviceName}" command must be a string array`)
    }
  }
}

function validateStep(step: QaStep, label: string, errors: string[]): void {
  const record = step as unknown as Record<string, unknown>
  switch (step.type) {
    case 'service.start':
      requiredString(record.service, `${label}.service`, errors)
      break
    case 'project.test':
      if (record.command !== undefined && (!Array.isArray(record.command) || record.command.some(item => typeof item !== 'string'))) {
        errors.push(`${label}.command must be a string array`)
      }
      break
    case 'ui':
      requiredString(record.action, `${label}.action`, errors)
      break
    case 'api':
      requiredString(record.url, `${label}.url`, errors)
      break
    case 'db.query':
      requiredString(record.sql, `${label}.sql`, errors)
      break
    case 'log.query':
      requiredString(record.source, `${label}.source`, errors)
      break
  }
}

function requiredString(value: unknown, label: string, errors: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${label} must be a non-empty string`)
    return undefined
  }
  return value
}

function collectEnvRefs(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) output.add(match[1]!)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEnvRefs(item, output)
    return
  }
  const record = asRecord(value)
  if (record !== undefined) for (const item of Object.values(record)) collectEnvRefs(item, output)
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
