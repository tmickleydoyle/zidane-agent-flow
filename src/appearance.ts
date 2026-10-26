/**
 * zidane's appearance, read from the desktop app: its live `--zg-*` tokens
 * (theme, accent override, contrast, fonts), whether it is light or dark, and
 * its interface scale.
 *
 * The desktop app keeps appearance in its window (CSS variables on <html>,
 * preferences in the window's localStorage), not in shared settings, and
 * extensions run in the app's main process. So the probe asks the app window
 * itself, with a read-only script. Elsewhere (the TUI, the daemon) there is
 * no probe and the visualizer uses its own light or dark palette.
 */

export interface ZidaneAppearance {
  /** `--zg-*` custom properties as the app window computes them. */
  vars: Record<string, string>
  appearance: 'light' | 'dark'
  /** The app's interface scale (page zoom factor). */
  scale: number
}

/** Runs in the app window: reads, never writes. */
const PROBE_JS = `(() => {
  const root = document.documentElement
  const cs = getComputedStyle(root)
  const vars = {}
  for (let i = 0; i < cs.length; i++) {
    const name = cs[i]
    if (name.startsWith('--zg-')) vars[name] = cs.getPropertyValue(name).trim()
  }
  if (!vars['--zg-bg']) return null
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--zg-bg)'
  root.appendChild(probe)
  const bg = getComputedStyle(probe).color
  probe.remove()
  return { vars, bg }
})()`

/** Relative luminance of a computed CSS color (`rgb(…)` or `color(srgb …)`); undefined when unreadable. */
export function luminance(color: string): number | undefined {
  const nums = color.match(/[\d.]+/g)?.map(Number)
  if (!nums || nums.length < 3)
    return undefined
  const srgb = color.startsWith('color(') ? nums.slice(0, 3) : nums.slice(0, 3).map(n => n / 255)
  const lin = srgb.map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!
}

/** Keep only well-formed custom properties, bounded, so the page never gets something odd. */
export function sanitizeVars(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object')
    return out
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (/^--zg-[a-z0-9-]+$/.test(name) && typeof value === 'string' && value.length <= 500 && !/[<>{};]/.test(value))
      out[name] = value
    if (Object.keys(out).length >= 400)
      break
  }
  return out
}

interface ElectronWebContents {
  isDestroyed: () => boolean
  getZoomFactor: () => number
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>
}
interface ElectronWindow {
  isDestroyed: () => boolean
  webContents: ElectronWebContents
}
interface ElectronModule {
  BrowserWindow: { getAllWindows: () => ElectronWindow[], getFocusedWindow: () => ElectronWindow | null }
}

/**
 * A probe when running in the desktop app's main process, else undefined.
 * Results are cached for `ttlMs` so several viewers do not each ask the window.
 */
export function createDesktopAppearanceProbe(ttlMs = 1000): (() => Promise<ZidaneAppearance | undefined>) | undefined {
  const proc = process as NodeJS.Process & { type?: string }
  if (!process.versions.electron || proc.type !== 'browser')
    return undefined
  let electron: ElectronModule | undefined
  let cached: { at: number, value: ZidaneAppearance | undefined } | undefined

  const read = async (): Promise<ZidaneAppearance | undefined> => {
    if (!electron) {
      // Only present inside Electron; a variable keeps type checking and bundlers off it.
      const specifier = 'electron'
      const mod = await import(specifier) as ElectronModule & { default?: ElectronModule }
      electron = mod.BrowserWindow ? mod : mod.default
    }
    const { BrowserWindow } = electron!
    const focused = BrowserWindow.getFocusedWindow()
    const windows = [focused, ...BrowserWindow.getAllWindows().filter(w => w !== focused)]
    for (const win of windows) {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed())
        continue
      let result: unknown
      try {
        result = await win.webContents.executeJavaScript(PROBE_JS, false)
      }
      catch {
        continue
      }
      if (!result || typeof result !== 'object')
        continue
      const { vars, bg } = result as { vars?: unknown, bg?: unknown }
      const clean = sanitizeVars(vars)
      if (!clean['--zg-bg'])
        continue
      const lum = typeof bg === 'string' ? luminance(bg) : undefined
      const scale = win.webContents.getZoomFactor()
      return {
        vars: clean,
        appearance: lum !== undefined && lum > 0.4 ? 'light' : 'dark',
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      }
    }
    return undefined
  }

  return async () => {
    if (cached && Date.now() - cached.at < ttlMs)
      return cached.value
    let value: ZidaneAppearance | undefined
    try {
      value = await read()
    }
    catch {
      value = undefined
    }
    cached = { at: Date.now(), value }
    return value
  }
}
