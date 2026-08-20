/**
 * Standalone dual-half build: a Node host plugin plus a browser bundle that
 * registers itself with the Harness module loader.
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-test-assistant'

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

const host: UserConfig = {
  name: PLUGIN_ID,
  entry: { index: 'src/index.ts', qa: 'src/qa/index.ts', workbench: 'src/workbench.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
}

const client: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...PLATFORM_MODULES],
    alwaysBundle: (id: string) => PLATFORM_MODULES.includes(
      id as (typeof PLATFORM_MODULES)[number],
    ) ? undefined : true,
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
