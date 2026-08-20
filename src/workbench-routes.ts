import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWorkbenchConfig, readWorkbenchSnapshot, saveWorkbenchConfig, type WorkbenchScaffoldInput } from './workbench.js'
import { runQaPlan } from './qa/engine.js'

const MAX_BODY_BYTES = 1024 * 1024
const running = new Map<string, Promise<unknown>>()

export function registerWorkbenchRoutes(ctx: Context): Array<() => void> {
  return [
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-test-assistant/workbench',
      async handler(req, res) {
        if (!allowLoopback(req, res) || req.method !== 'GET') return methodNotAllowed(res)
        try {
          const workspace = workspaceFor(ctx, querySessionId(req))
          json(res, 200, readWorkbenchSnapshot(workspace))
        } catch (cause) {
          jsonError(res, cause)
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-test-assistant/workbench/scaffold',
      async handler(req, res) {
        if (!allowLoopback(req, res) || req.method !== 'POST') return methodNotAllowed(res)
        try {
          const body = await readBody<{ sessionId?: unknown; input?: unknown }>(req)
          const workspace = workspaceFor(ctx, requiredSessionId(body.sessionId))
          const discovery = readWorkbenchSnapshot(workspace).discovery
          const config = createWorkbenchConfig(discovery, record(body.input) as WorkbenchScaffoldInput)
          json(res, 200, saveWorkbenchConfig(workspace, config))
        } catch (cause) {
          jsonError(res, cause)
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-test-assistant/workbench/config',
      async handler(req, res) {
        if (!allowLoopback(req, res) || req.method !== 'PUT') return methodNotAllowed(res)
        try {
          const body = await readBody<{ sessionId?: unknown; config?: unknown }>(req)
          const workspace = workspaceFor(ctx, requiredSessionId(body.sessionId))
          json(res, 200, saveWorkbenchConfig(workspace, body.config))
        } catch (cause) {
          jsonError(res, cause)
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-test-assistant/workbench/run',
      async handler(req, res) {
        if (!allowLoopback(req, res) || req.method !== 'POST') return methodNotAllowed(res)
        try {
          const body = await readBody<{
            sessionId?: unknown
            environment?: unknown
            suiteIds?: unknown
            caseIds?: unknown
            confirmWrite?: unknown
            confirmDestructive?: unknown
          }>(req)
          const sessionId = requiredSessionId(body.sessionId)
          const workspace = workspaceFor(ctx, sessionId)
          if (running.has(workspace)) throw new Error('QA run is already active for this workspace')
          const task = runQaPlan({
            workspace,
            ...(typeof body.environment === 'string' ? { environment: body.environment } : {}),
            ...(stringArray(body.suiteIds) ? { suiteIds: body.suiteIds } : {}),
            ...(stringArray(body.caseIds) ? { caseIds: body.caseIds } : {}),
            confirmWrite: body.confirmWrite === true,
            confirmDestructive: body.confirmDestructive === true,
          })
          running.set(workspace, task)
          try {
            json(res, 200, await task)
          } finally {
            if (running.get(workspace) === task) running.delete(workspace)
          }
        } catch (cause) {
          jsonError(res, cause)
        }
      },
    }),
  ]
}

function workspaceFor(ctx: Context, sessionId: string): string {
  const agent = ctx.agents.get(SessionId(sessionId))
  const workspace = agent?.session.header.cwd
  if (workspace === undefined) throw new Error(`session "${sessionId}" has no live workspace`)
  return workspace
}

function querySessionId(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  return requiredSessionId(url.searchParams.get('sessionId'))
}

function requiredSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) throw new Error('sessionId is required')
  return value
}

function allowLoopback(req: IncomingMessage, res: ServerResponse): boolean {
  const address = req.socket.remoteAddress ?? ''
  const allowed = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!allowed) json(res, 403, { error: 'workbench API accepts loopback requests only' })
  return allowed
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('application/json')) throw new Error('content-type must be application/json')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

function methodNotAllowed(res: ServerResponse): void {
  if (!res.headersSent) json(res, 405, { error: 'method not allowed' })
}

function jsonError(res: ServerResponse, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause)
  const status = /required|not valid|validation|must |exceeds|already active/i.test(message) ? 400 : 500
  json(res, status, { error: message })
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export const workbenchRouteInternals = { requiredSessionId, stringArray }
