import { describe, expect, it } from 'bun:test'
import { createDesktopAppearanceProbe, luminance, sanitizeVars } from '../src/appearance'
import { startFlowServer } from '../src/server'
import { FlowStore } from '../src/store'

describe('appearance helpers', () => {
  it('reads luminance from rgb() and color(srgb …)', () => {
    expect(luminance('rgb(255, 255, 255)')!).toBeCloseTo(1, 3)
    expect(luminance('rgb(13, 16, 19)')!).toBeLessThan(0.05)
    expect(luminance('color(srgb 0.98 0.98 0.98)')!).toBeGreaterThan(0.9)
    expect(luminance('transparent')).toBeUndefined()
  })

  it('keeps only well-formed --zg-* properties', () => {
    expect(sanitizeVars({
      '--zg-bg': '#fff',
      '--zg-text': 'color-mix(in oklab, #111 100%, #fff 0%)',
      '--other': 'red',
      '--zg-evil': 'red; } body { display: none',
      '--zg-html': '</style>',
      '--zg-num': 3,
    })).toEqual({ '--zg-bg': '#fff', '--zg-text': 'color-mix(in oklab, #111 100%, #fff 0%)' })
  })

  it('has no probe outside the desktop app', () => {
    expect(createDesktopAppearanceProbe()).toBeUndefined()
  })
})

describe('appearance over the server', () => {
  it('answers /api/appearance and pushes changes to viewers', async () => {
    let current = { vars: { '--zg-bg': '#ffffff' }, appearance: 'light' as const, scale: 1.25 }
    const server = await startFlowServer({ store: new FlowStore(), uiDir: '/nonexistent', port: 0, appearance: async () => current, appearancePollMs: 30 })
    try {
      const first = await fetch(`${server.url}api/appearance`).then(r => r.json()) as { appearance: typeof current }
      expect(first.appearance).toEqual(current)

      const res = await fetch(`${server.url}api/events`)
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      const until = async (needle: string) => {
        while (!text.includes(needle))
          text += decoder.decode((await reader.read()).value)
      }
      await until('"scale":1.25')
      current = { vars: { '--zg-bg': '#0d1013' }, appearance: 'dark' as never, scale: 1 }
      await until('#0d1013')
      expect(text).toContain('event: appearance')
      await reader.cancel()
    }
    finally {
      await server.close()
    }
  })

  it('answers null without a probe', async () => {
    const server = await startFlowServer({ store: new FlowStore(), uiDir: '/nonexistent', port: 0 })
    try {
      expect(await fetch(`${server.url}api/appearance`).then(r => r.json())).toMatchObject({ appearance: null })
    }
    finally {
      await server.close()
    }
  })
})
