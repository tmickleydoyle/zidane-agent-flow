import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildExtensionRegistry, createAgent, createMemoryStore, createProcessContext, createSession, definePreset, disposeExtensionRegistry, inlineLoadedExtension } from 'zidane'
import definition from '../index'

// Keep these servers away from a real zidane running the extension on this machine.
process.env.AGENT_FLOW_PEERS_DIR = mkdtempSync(join(tmpdir(), 'agent-flow-test-peers-'))
import { createMockProvider } from './mock-provider'

async function registry() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-test-'))
  return buildExtensionRegistry([inlineLoadedExtension(definition)], {
    // Port 0: any free port, so the test never fights a running host.
    readSettings: () => ({ extensionConfig: { 'agent-flow': { port: 0, persist: false } } }),
    storageDirs: { dataDir: dir, cacheDir: dir },
  })
}

describe('agent-flow extension', () => {
  it('serves the UI and live run data, feeds the panel, and stops on dispose', async () => {
    const reg = await registry()
    const loaded = reg.loaded.find(e => e.name === 'agent-flow')!
    expect(loaded.error).toBeUndefined()
    const contributions = loaded.contributions!
    const panel = contributions.panels.find(p => p.id.endsWith('flow'))!
    expect(panel).toBeDefined()
    expect(contributions.commands.map(c => c.name)).toContain('flow')

    const empty = await panel.load({ cwd: process.cwd(), scope: 'project' })
    const href = empty.sections.flatMap(s => s.items).find(i => i.kind === 'row' && 'href' in i && i.href)
    const url = (href as { href: string }).href
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

    const html = await fetch(url).then(r => r.text())
    expect(html).toContain('Agent Flow')
    expect((await fetch(`${url}app.js`)).headers.get('content-type')).toContain('javascript')
    expect((await fetch(`${url}../package.json`)).status).toBe(404)
    // DNS-rebinding guard: a foreign Host header is refused.
    const port = new URL(url).port
    const foreign = await new Promise<number>((resolve) => {
      require('node:http').get({ host: '127.0.0.1', port, path: '/api/runs', headers: { host: `evil.example:${port}` } }, (res: { statusCode: number, resume: () => void }) => {
        res.resume()
        resolve(res.statusCode)
      })
    })
    expect(foreign).toBe(403)

    const session = await createSession({ store: createMemoryStore() })
    const agent = createAgent({
      ...definePreset({ name: 'e2e', tools: {} }),
      provider: createMockProvider([{ text: 'Hello from the agent.' }]),
      session,
      extensions: reg,
    })
    await agent.run({ prompt: 'Say hello' })
    await agent.destroy()

    const { runs } = await fetch(`${url}api/runs`).then(r => r.json()) as { runs: Array<{ id: string, prompt: string, status: string }> }
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ prompt: 'Say hello', status: 'success' })
    const { run } = await fetch(`${url}api/runs/${encodeURIComponent(runs[0]!.id)}`).then(r => r.json()) as { run: { root: { children: Array<{ id: string, has: string[], data: Record<string, unknown> }> } } }
    const turn = run.root.children[0]!
    // The tree is lite; the node endpoint has the text.
    expect(turn.has).toContain('text')
    expect(turn.data.text).toBeUndefined()
    const { node } = await fetch(`${url}api/runs/${encodeURIComponent(runs[0]!.id)}/nodes/${encodeURIComponent(turn.id)}`).then(r => r.json()) as { node: { data: { text: string } } }
    expect(node.data.text).toBe('Hello from the agent.')

    const content = await panel.load({ cwd: process.cwd(), scope: 'session', sessionId: session.id })
    expect(content.sections.map(s => s.id)).toEqual(['summary', 'tree'])

    await disposeExtensionRegistry(reg)
    await expect(fetch(url)).rejects.toThrow()
  })

  it('shares one server across registries and closes it with the last one', async () => {
    const urlOf = async (reg: Awaited<ReturnType<typeof registry>>) => {
      const panel = reg.loaded.find(e => e.name === 'agent-flow')!.contributions!.panels[0]!
      const content = await panel.load({ cwd: process.cwd(), scope: 'project' })
      return (content.sections[0]!.items[0] as { href: string }).href
    }
    const a = await registry()
    const b = await registry()
    const url = await urlOf(a)
    expect(await urlOf(b)).toBe(url)
    await disposeExtensionRegistry(a)
    expect((await fetch(url)).status).toBe(200)
    await disposeExtensionRegistry(b)
    await expect(fetch(url)).rejects.toThrow()
  })

  it('clears a request zidane never finished once the host says the conversation settled', async () => {
    const reg = await registry()
    try {
      const contributions = reg.loaded.find(e => e.name === 'agent-flow')!.contributions!
      const url = ((await contributions.panels[0]!.load({ cwd: process.cwd(), scope: 'project' })).sections[0]!.items[0] as { href: string }).href
      const session = await createSession({ store: createMemoryStore() })
      const broken = { ...createProcessContext(), spawn: async () => {
        throw new Error('sandbox failed to start')
      } }
      const agent = createAgent({ ...definePreset({ name: 'e2e', tools: {} }), provider: createMockProvider([{ text: 'never' }]), session, execution: broken as never, extensions: reg })
      await agent.run({ prompt: 'doomed' }).catch(() => {})
      const running = async () => ((await fetch(`${url}api/runs`).then(r => r.json())) as { runs: Array<{ status: string }> }).runs.filter(r => r.status === 'running').length
      expect(await running()).toBe(1)
      // What the desktop app / daemon calls after every prompt run.
      for (const handler of contributions.runSettled)
        await handler({ sessionId: session.id, runId: 'host-run-id', ok: false, aborted: false, session: null, decide: (async () => ({ ok: false })) as never })
      expect(await running()).toBe(0)
    }
    finally {
      await disposeExtensionRegistry(reg)
    }
  })
})
