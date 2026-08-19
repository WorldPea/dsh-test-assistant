/**
 * dsh-test-assistant — Client 端入口。
 * 注册测试面板到对话视图环的「测试」标签页。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { TestKey } from './locales.js'
import { zh, en } from './locales.js'
import { TestPanel } from './panel.js'

/** 国际化命名空间 */
const NS = 'dsh-test-assistant'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-test-assistant': TestKey
  }
}

/** 依赖的客户端 cordis 服务 */
export const inject = ['slots', 'locale']

/**
 * 挂载测试面板。
 */
export function apply(ctx: ClientContext): void {
  // 注册国际化文案
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-test-assistant: locales')
  const t = ctx.locale.bind(NS)

  // 注册测试面板到对话视图环
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'test',
    order: 200,
    label: () => t('panel.title'),
    locale: NS,
  }, TestPanel))
}
