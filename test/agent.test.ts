import type { Provider, ToolContext, ToolDef } from 'zidane'
import { describe, expect, it } from 'bun:test'
import { buildExtensionRegistry, createAgent, createMemoryStore, createProcessContext, createSession, createSpawnTool, definePreset, inlineLoadedExtension } from 'zidane'
import { registerFlowHooks } from '../src/hooks'
import { FlowStore } from '../src/store'
import { createMockProvider } from './mock-provider'

const echo: ToolDef = {
  spec: {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  execute: async input => `echo: ${String(input.text)}`,
}

/** `spawn` that hands each successive child the next provider. */
function spawnWith(queue: Provider[]): ToolDef {
  const spawn = createSpawnTool()
  return { ...spawn, execute: (input: Record<string, unknown>, ctx: ToolContext) => spawn.execute(input, { ...ctx, provider: queue.shift() ?? ctx.provider }) }
}

async function flowAgent(root: Provider, children: Provider[]) {
  const store = new FlowStore()
  const registry = await buildExtensionRegistry([inlineLoadedExtension({ name: 'agent-flow-test', setup: ctx => registerFlowHooks(ctx, store) })])
  const session = await createSession({ store: createMemoryStore() })
  const agent = createAgent({
    ...definePreset({ name: 'flow-test', tools: { echo, spawn: spawnWith(children) } }),
    provider: root,
    session,
    extensions: registry,
  })
  return { store, agent, session }
}

describe('agent-flow against a real zidane agent', () => {
  it('records the run tree with turns, tools and nested subagents', async () => {
    const { store, agent, session } = await flowAgent(
      createMockProvider([
        { text: 'Let me check.', thinking: 'plan first', toolCalls: [{ id: 'e1', name: 'echo', input: { text: 'hi' } }] },
        { text: 'Delegating.', toolCalls: [{ id: 's1', name: 'spawn', input: { task: 'research the API' } }] },
        { text: 'All done.' },
      ]),
      [
        createMockProvider([
          { text: 'Child digging.', toolCalls: [{ id: 'ce1', name: 'echo', input: { text: 'child' } }, { id: 's2', name: 'spawn', input: { task: 'go deeper' } }] },
          { text: 'Child done.' },
        ], 'child'),
        createMockProvider([{ text: 'Grandchild done.' }], 'grandchild'),
      ],
    )
    await agent.run({ prompt: 'Investigate the API' })
    await agent.destroy()

    const runs = store.listRuns()
    expect(runs).toHaveLength(1)
    const run = store.getRun(runs[0]!.id)!
    expect(run.sessionId).toBe(session.id)
    expect(run.prompt).toBe('Investigate the API')
    expect(run.status).toBe('success')

    const turns = run.root.children
    expect(turns.map(t => t.kind)).toEqual(['turn', 'turn', 'turn'])
    expect(turns[0]!.data.thinking).toBe('plan first')
    expect(turns[0]!.children[0]).toMatchObject({ kind: 'tool', label: 'echo', status: 'success', data: { output: 'echo: hi' } })

    const spawnCall = turns[1]!.children[0]!
    expect(spawnCall).toMatchObject({ kind: 'tool', data: { tool: 'spawn' } })
    const child = spawnCall.children.find(n => n.kind === 'agent')!
    expect(child).toMatchObject({ status: 'success', detail: 'research the API' })

    const childTurns = child.children.filter(n => n.kind === 'turn')
    expect(childTurns).toHaveLength(2)
    expect(childTurns[0]!.data.text).toBe('Child digging.')
    const childTools = childTurns[0]!.children
    expect(childTools.map(t => t.data.tool)).toEqual(['echo', 'spawn'])
    const grand = childTools[1]!.children.find(n => n.kind === 'agent')!
    expect(grand).toMatchObject({ status: 'success', detail: 'go deeper' })
    expect(grand.children[0]).toMatchObject({ kind: 'turn', data: { text: 'Grandchild done.' } })

    const summary = store.listRuns()[0]!
    expect(summary.stats).toMatchObject({ turns: 6, tools: 4, agents: 2, errors: 0 })
  })

  it('keeps concurrent sessions apart, though both runs are run_1', async () => {
    // One store shared across agents, as the extension shares it across registries.
    const store = new FlowStore()
    const registry = await buildExtensionRegistry([inlineLoadedExtension({ name: 'agent-flow-test', setup: ctx => registerFlowHooks(ctx, store) })])
    const make = async (label: string, slowFirst: boolean) => {
      const session = await createSession({ store: createMemoryStore() })
      const agent = createAgent({
        ...definePreset({ name: 'flow-test', tools: { echo } }),
        provider: createMockProvider([
          { text: `${label}1`, toolCalls: [{ id: `x${label}`, name: 'echo', input: { text: label } }], ...(slowFirst ? { delayMs: 20 } : {}) },
          { text: `${label} done`, ...(slowFirst ? {} : { delayMs: 20 }) },
        ]),
        session,
        extensions: registry,
      })
      return { label, session, agent }
    }
    const pair = [await make('A', true), await make('B', false)]
    await Promise.all(pair.map(p => p.agent.run({ prompt: `session ${p.label}` })))
    await Promise.all(pair.map(p => p.agent.destroy()))

    expect(store.listRuns()).toHaveLength(2)
    for (const { label, session } of pair) {
      const run = store.latestRun(session.id)!
      expect(run.prompt).toBe(`session ${label}`)
      expect(run.status).toBe('success')
      const [t1, t2] = run.root.children
      expect(t1!.data.text).toBe(`${label}1`)
      expect(t1!.children[0]!.data.output).toBe(`echo: ${label}`)
      expect(t2!.data.text).toBe(`${label} done`)
    }
  })

  it('keeps 16 concurrent sessions with subagents apart', async () => {
    const store = new FlowStore()
    const registry = await buildExtensionRegistry([inlineLoadedExtension({ name: 'agent-flow-test', setup: ctx => registerFlowHooks(ctx, store) })])
    const jitter = (i: number, k: number) => ((i * 7 + k * 3) % 5) * 3
    const sessions = await Promise.all(Array.from({ length: 16 }, async (_, i) => {
      const session = await createSession({ store: createMemoryStore() })
      const tag = `s${i}`
      const agent = createAgent({
        ...definePreset({ name: 'flow-test', tools: { echo, spawn: spawnWith([
          createMockProvider([
            { text: `${tag} child working`, delayMs: jitter(i, 1), toolCalls: [{ id: `${tag}-ce`, name: 'echo', input: { text: `${tag}-child` } }] },
            { text: `${tag} child done`, delayMs: jitter(i, 2) },
          ]),
        ]) } }),
        provider: createMockProvider([
          { text: `${tag} start`, delayMs: jitter(i, 3), toolCalls: [{ id: `${tag}-e`, name: 'echo', input: { text: tag } }] },
          { text: `${tag} delegate`, delayMs: jitter(i, 4), toolCalls: [{ id: `${tag}-s`, name: 'spawn', input: { task: `${tag} task` } }] },
          { text: `${tag} done`, delayMs: jitter(i, 5) },
        ]),
        session,
        extensions: registry,
      })
      return { tag, session, agent }
    }))
    await Promise.all(sessions.map(s => s.agent.run({ prompt: `prompt ${s.tag}` })))
    await Promise.all(sessions.map(s => s.agent.destroy()))

    expect(store.listRuns()).toHaveLength(16)
    expect(store.openRunCount()).toBe(0)
    for (const { tag, session } of sessions) {
      const run = store.latestRun(session.id)!
      expect(run.prompt).toBe(`prompt ${tag}`)
      expect(run.status).toBe('success')
      // Every text in this tree belongs to this session.
      const texts: string[] = []
      const walk = (n: typeof run.root): void => {
        if (n.data.text)
          texts.push(n.data.text)
        if (n.data.output)
          texts.push(n.data.output)
        n.children.forEach(walk)
      }
      walk(run.root)
      expect(texts.length).toBeGreaterThan(5)
      expect(texts.every(t => t.includes(tag) || t.includes('child-1'))).toBe(true)
      const [t1, t2, t3] = run.root.children
      expect([t1, t2, t3].map(t => t!.data.text)).toEqual([`${tag} start`, `${tag} delegate`, `${tag} done`])
      const helper = t2!.children[0]!.children.find(n => n.kind === 'agent')!
      expect(helper).toMatchObject({ status: 'success', detail: `${tag} task` })
      expect(helper.children.map(n => n.data.text)).toEqual([`${tag} child working`, `${tag} child done`])
      expect(helper.children[0]!.children[0]!.data.output).toBe(`echo: ${tag}-child`)
    }
  })

  it('does not leave a phantom running request when zidane never reports a failed setup', async () => {
    const store = new FlowStore()
    const registry = await buildExtensionRegistry([inlineLoadedExtension({ name: 'agent-flow-test', setup: ctx => registerFlowHooks(ctx, store) })])
    const session = await createSession({ store: createMemoryStore() })
    // A sandbox that cannot start: zidane fires session:start and agent:start, then throws without session:end or agent:done.
    const broken = { ...createProcessContext(), spawn: async () => {
      throw new Error('sandbox failed to start')
    } }
    const failing = createAgent({ ...definePreset({ name: 'flow-test', tools: { echo } }), provider: createMockProvider([{ text: 'never' }]), session, execution: broken as never, extensions: registry })
    await expect(failing.run({ prompt: 'first try' })).rejects.toThrow('sandbox failed to start')
    expect(store.openRunCount()).toBe(1) // what zidane leaves behind

    // The next request in the conversation proves the first one is over.
    const working = createAgent({ ...definePreset({ name: 'flow-test', tools: { echo } }), provider: createMockProvider([{ text: 'second try works' }]), session, extensions: registry })
    await working.run({ prompt: 'second try' })
    await working.destroy()
    const runs = store.listRuns()
    const first = runs.find(r => r.prompt === 'first try')
    const second = runs.find(r => r.prompt === 'second try')
    expect(first).toMatchObject({ prompt: 'first try', status: 'cancelled', endedBy: 'inferred' })
    expect(second).toMatchObject({ prompt: 'second try', status: 'success', endedBy: 'event' })
    expect(store.openRunCount()).toBe(0)
  })
})
