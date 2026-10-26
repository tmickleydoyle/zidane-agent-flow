/**
 * Demo only: what the desktop app's window would report for a theme, built
 * from a zidane checkout (ZIDANE_REPO, default ../zidane): its token
 * stylesheet, then the theme's palette on top, as the app applies them.
 */
import type { ZidaneAppearance } from '../src/appearance'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export async function zidaneThemeFixture(themeId: string, scale = 1): Promise<ZidaneAppearance> {
  const repo = resolve(process.env.ZIDANE_REPO ?? join(import.meta.dir, '../../zidane'))
  const tokens = readFileSync(join(repo, 'ui/src/styles/tokens.css'), 'utf8')
  const vars: Record<string, string> = {}
  // The first :root block holds the defaults and the contrast/depth layer.
  const rootBlock = tokens.slice(tokens.indexOf(':root'), tokens.indexOf('\n}', tokens.indexOf(':root')))
  for (const m of rootBlock.matchAll(/(--zg-[a-z0-9-]+)\s*:\s*([^;]+);/g))
    vars[m[1]!] = m[2]!.replace(/\s+/g, ' ').trim()
  const { themeCssVars } = await import(join(repo, 'ui/src/theme/stylesheet.ts'))
  const { resolveTheme } = await import(join(repo, 'ui/src/theme/themes.ts'))
  const { seedFromTheme } = await import(join(repo, 'ui/src/theme/from-theme.ts'))
  const { inferAppearance } = await import(join(repo, 'ui/src/theme/derive.ts'))
  Object.assign(vars, themeCssVars(themeId))
  const appearance = inferAppearance(seedFromTheme(resolveTheme(themeId)).canvas) as 'light' | 'dark'
  return { vars, appearance, scale }
}
