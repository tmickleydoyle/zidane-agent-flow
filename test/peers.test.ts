import type { ZidaneAppearance } from '../src/appearance'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { createPeerDirectory } from '../src/peers'
import { startFlowServer } from '../src/server'
import { FlowStore, ROOT } from '../src/store'

const lightTheme: ZidaneAppearance = { vars: { '--zg-bg': '#f6f8fa' }, appearance: 'light', scale: 1 }

async function pair() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-flow-peers-'))
  // Two processes in real life; two peer identities here.
  const desktopPeers = createPeerDirectory(dir, { pid: process.pid, kind: 'desktop' })
  const daemonPeers = createPeerDirectory(dir, { pid: process.pid, kind: 'daemon' })
  const desktopStore = new FlowStore()
  const daemonStore = new FlowStore()
  const desktop = await startFlowServer({ store: desktopStore, uiDir: '/nonexistent', port: 0, peers: desktopPeers, appearance: async () => lightTheme, peerSyncMs: 20 })
  const daemon = await startFlowServer({ store: daemonStore, uiDir: '/nonexistent', port: 0, peers: daemonPeers, peerSyncMs: 20 })
  desktopPeers.register(desktop.port)
  daemonPeers.register(daemon.port)
  return { dir, desktop, daemon, desktopStore, daemonStore, desktopPeers, daemonPeers }
}

describe('peers: the desktop app shows what runs in the daemon', () => {
  it('lists, opens and details the daemon\'s runs from the desktop\'s page', async () => {
    const { desktop, daemon, daemonStore } = await pair()
    try {
      const r = daemonStore.startRun({ runId: 'run_1', sessionId: 's1', prompt: 'from the daemon' }).id
      daemonStore.toolStart(r, ROOT, { turnId: 'u1', callId: 'c1', name: 'shell', input: { command: 'ls' } })

      const list = await fetch(`${desktop.url}api/runs`).then(res => res.json()) as { runs: Array<{ id: string, status: string }> }
      expect(list.runs).toEqual([expect.objectContaining({ id: r, status: 'running' })])
      // Its own-only view stays empty: peers never relay each other.
      expect((await fetch(`${desktop.url}api/runs?local=1`).then(res => res.json()) as { runs: unknown[] }).runs).toEqual([])

      const run = await fetch(`${desktop.url}api/runs/${encodeURIComponent(r)}`).then(res => res.json()) as { run: { prompt: string } }
      expect(run.run.prompt).toBe('from the daemon')
      const node = await fetch(`${desktop.url}api/runs/${encodeURIComponent(r)}/nodes/t%3Ac1`).then(res => res.json()) as { node: { data: { input: string } } }
      expect(node.node.data.input).toContain('ls')
      expect((await desktop.remoteLatestRun('s1'))?.prompt).toBe('from the daemon')
    }
    finally {
      await desktop.close()
      await daemon.close()
    }
  })

  it('relays the daemon\'s live changes to the desktop\'s viewers and panel', async () => {
    const { desktop, daemon, daemonStore } = await pair()
    try {
      let panelPings = 0
      const off = desktop.onRemoteChange(() => void panelPings++)
      const res = await fetch(`${desktop.url}api/events`)
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      // Let the relay connect, then make a change in the daemon.
      await new Promise(resolve => setTimeout(resolve, 120))
      const id = daemonStore.startRun({ runId: 'run_7', sessionId: 's2', prompt: 'live' }).id
      while (!text.includes(id))
        text += decoder.decode((await reader.read()).value)
      expect(text).toContain('event: change')
      expect(panelPings).toBeGreaterThan(0)
      await reader.cancel()
      off()
    }
    finally {
      await desktop.close()
      await daemon.close()
    }
  })

  it('gives the daemon\'s page the desktop\'s theme, and forgets peers that stop', async () => {
    const { dir, desktop, daemon, daemonStore, desktopPeers } = await pair()
    try {
      const fromDaemon = await fetch(`${daemon.url}api/appearance`).then(res => res.json()) as { appearance: ZidaneAppearance | null }
      expect(fromDaemon.appearance).toEqual(lightTheme)
      daemonStore.startRun({ runId: 'run_1', sessionId: 's3' })
      await daemon.close()
      expect((await fetch(`${desktop.url}api/runs`).then(res => res.json()) as { runs: unknown[] }).runs).toEqual([])
      // A dead process's entry is cleaned up when read.
      writeFileSync(join(dir, '999999-1.json'), JSON.stringify({ pid: 999999, port: 1, kind: 'daemon', startedAt: 0 }))
      expect(desktopPeers.list().some(p => p.pid === 999999)).toBe(false)
      expect(readdirSync(dir)).not.toContain('999999-1.json')
    }
    finally {
      await desktop.close()
    }
  })
})
