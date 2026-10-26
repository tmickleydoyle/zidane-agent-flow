/**
 * Live demo: loads the real extension, starts its visualizer, and drives
 * scripted zidane agents (no LLM calls) through it, in two sessions, with
 * tools, failures and nested subagents.
 *
 *   bun scripts/demo.ts                    # http://127.0.0.1:7430/
 *   DEMO_PORT=8000 DEMO_SESSIONS=12 bun scripts/demo.ts
 *   DEMO_THEME=light DEMO_SCALE=1.2 bun scripts/demo.ts   # as if zidane's desktop app used that theme and size
 */
import type { Provider, ToolContext, ToolDef } from 'zidane'
import { join } from 'node:path'
import { buildExtensionRegistry, createAgent, createMemoryStore, createSession, createSpawnTool, definePreset, inlineLoadedExtension } from 'zidane'
import { registerFlowHooks } from '../src/hooks'
import { startFlowServer } from '../src/server'
import { FlowStore } from '../src/store'
import { createMockProvider } from '../test/mock-provider'
import { zidaneThemeFixture } from './zidane-theme-fixture'

const port = Number(process.env.DEMO_PORT ?? 7430)
const concurrent = Number(process.env.DEMO_SESSIONS ?? 6)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function fakeTool(name: string, description: string, run: (input: Record<string, unknown>) => string): ToolDef {
  return {
    spec: { name, description, inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
    async execute(input) {
      await sleep(Number(input.ms ?? 400))
      return run(input)
    },
  }
}

const toolset = {
  shell: fakeTool('shell', 'Run a command.', (i) => {
    if (String(i.command).includes('fail'))
      throw new Error(`Command failed with exit code 1: ${String(i.command)}`)
    return `$ ${String(i.command)}\n✓ 42 tests passed\n`
  }),
  read_file: fakeTool('read_file', 'Read a file.', i => `// ${String(i.path)}\nexport function handler(req) {\n  return fetch(req.url)\n}\n`),
  grep: fakeTool('grep', 'Search.', i => `src/api.ts:12: ${String(i.pattern)}\nsrc/routes.ts:40: ${String(i.pattern)}`),
  edit: fakeTool('edit', 'Edit a file.', i => `Edited ${String(i.path)} (+3 -1)`),
  web_fetch: fakeTool('web_fetch', 'Fetch a URL.', i => `<html>docs for ${String(i.url)}</html>`),
}

function spawnWith(queue: Provider[]): ToolDef {
  const spawn = createSpawnTool()
  return { ...spawn, execute: (input: Record<string, unknown>, ctx: ToolContext) => spawn.execute(input, { ...ctx, provider: queue.shift() ?? ctx.provider }) }
}

let ids = 0
const call = (name: string, input: Record<string, unknown>) => ({ id: `toolu_${(++ids).toString(36)}_${Math.random().toString(36).slice(2, 8)}`, name, input })

const store = new FlowStore()
const registry = await buildExtensionRegistry([inlineLoadedExtension({ name: 'agent-flow-demo', setup: ctx => registerFlowHooks(ctx, store) })])
const theme = process.env.DEMO_THEME
  ? await zidaneThemeFixture(process.env.DEMO_THEME, Number(process.env.DEMO_SCALE ?? 1))
  : undefined
await startFlowServer({ store, uiDir: join(import.meta.dir, '../ui'), port, label: 'Demo: scripted practice conversations, not your zidane.', ...(theme ? { appearance: async () => theme } : {}) })

async function session(prompt: string, root: Provider, children: Provider[] = []) {
  const s = await createSession({ store: createMemoryStore() })
  const agent = createAgent({
    ...definePreset({ name: 'demo', tools: { ...toolset, spawn: spawnWith(children) } }),
    provider: root,
    session: s,
    extensions: registry,
  })
  await agent.run({ prompt }).catch(() => {})
  return { s, agent }
}

console.log(`Agent Flow demo → http://127.0.0.1:${port}/`)

async function scenarioBugfix() {
  await session('Fix the flaky checkout test and make sure CI is green', createMockProvider([
    { text: 'I will reproduce the failure first, then look at the test and the handler.', thinking: 'The test is flaky: likely a race on the mocked clock. Reproduce, then read the handler.', chunkDelayMs: 40, toolCalls: [call('shell', { command: 'bun test checkout --fail', ms: 1400 }), call('grep', { pattern: 'setTimeout', ms: 500 })] },
    { text: 'The handler awaits a timer that the test never advances. Reading both files.', chunkDelayMs: 35, toolCalls: [call('read_file', { path: 'src/checkout.ts', ms: 300 }), call('read_file', { path: 'test/checkout.test.ts', ms: 350 })] },
    { text: 'Delegating a check of other timer-based tests while I patch this one.', chunkDelayMs: 30, toolCalls: [call('spawn', { task: 'Find other tests that depend on real timers and list them' }), call('edit', { path: 'src/checkout.ts', ms: 600 })] },
    { text: 'Patched. Running the suite.', chunkDelayMs: 30, toolCalls: [call('shell', { command: 'bun test', ms: 2200 })] },
    { text: 'All 42 tests pass. The fix injects the clock instead of awaiting a real timer; two other suites use real timers and are listed above.', chunkDelayMs: 25 },
  ]), [
    createMockProvider([
      { text: 'Searching for real timer usage in tests.', chunkDelayMs: 40, toolCalls: [call('grep', { pattern: 'setTimeout|setInterval', ms: 900 }), call('spawn', { task: 'Check whether the payments suite mocks Date.now' })] },
      { text: 'Two suites use real timers: payments and email-retry.', chunkDelayMs: 30 },
    ], 'subagent'),
    createMockProvider([
      { text: 'Reading the payments suite.', chunkDelayMs: 40, toolCalls: [call('read_file', { path: 'test/payments.test.ts', ms: 700 })] },
      { text: 'It does not mock Date.now.', chunkDelayMs: 30 },
    ], 'subagent'),
  ])
}

async function scenarioResearch() {
  await session('Compare our API pagination with the Stripe docs', createMockProvider([
    { text: 'Fetching the reference docs and our routes in parallel.', chunkDelayMs: 50, toolCalls: [call('web_fetch', { url: 'https://docs.stripe.com/api/pagination', ms: 1800 }), call('grep', { pattern: 'cursor', ms: 600 })] },
    { text: 'Stripe uses starting_after / ending_before cursors; we use page numbers. Writing up the differences.', chunkDelayMs: 45 },
  ]))
}

// Seed some history, then keep several conversations running at once,
// staggered, so the live overview always has work in flight.
await scenarioResearch()
for (;;) {
  await Promise.all(Array.from({ length: concurrent }, (_, i) =>
    sleep(i * 900).then(() => (i % 2 ? scenarioResearch() : scenarioBugfix()))))
  await sleep(4000)
}
