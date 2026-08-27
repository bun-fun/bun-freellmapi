import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, 'settings-dialog.tsx'), 'utf8')
const en = JSON.parse(readFileSync(path.join(here, '../i18n/locales/en.json'), 'utf8')) as unknown

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>(
    (value, part) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined),
    en,
  )
}

describe('settings dialog i18n', () => {
  it('resolves every literal t() key against en.json', () => {
    const keys = [...source.matchAll(/\bt\('([^']+)'\)/g)].map(match => match[1])
    expect(keys.length).toBeGreaterThan(20)
    for (const key of keys) {
      expect(typeof lookup(key), `missing translation for ${key}`).toBe('string')
    }
  })

  it('has a label and a tooltip for every compression engine listed in the dialog', () => {
    // Engine ids must stay in sync with server/src/services/compression/engines.
    const ids = [...source.matchAll(/\{ id: '([^']+)', tKey: '([^']+)', lossless:/g)]
    expect(ids.map(match => match[1])).toEqual([
      'dedup',
      'lite',
      'read-lifecycle',
      'toolfilter',
      'jsoncompact',
      'relevance',
      'aging',
      'hard-budget',
    ])
    for (const [, , tKey] of ids) {
      expect(typeof lookup(`settings.${tKey}`), `missing settings.${tKey}`).toBe('string')
      expect(typeof lookup(`settings.${tKey}Help`), `missing settings.${tKey}Help`).toBe('string')
    }
  })

  it('has a label for every sidebar section', () => {
    const sections = [...source.matchAll(/\{ id: '([^']+)', tKey: '(section[^']+)'/g)]
    expect(sections.map(match => match[1])).toEqual(['general', 'compression', 'advanced', 'preview'])
    for (const [, , tKey] of sections) {
      expect(typeof lookup(`settings.${tKey}`), `missing settings.${tKey}`).toBe('string')
    }
  })
})

describe('compression mode presets', () => {
  // The dialog applies MODE_ENGINE_PRESETS to the engine switches when a mode
  // pill is clicked; it must mirror MODE_ENGINES in the server pipeline or the
  // preselected switches would lie about what the chosen mode actually runs.
  function parseClientPresets(): Record<string, string[]> {
    const block = source.match(/MODE_ENGINE_PRESETS[^=]*= \{([\s\S]*?)\n\}/)
    expect(block, 'MODE_ENGINE_PRESETS not found in settings-dialog.tsx').toBeTruthy()
    return Object.fromEntries(
      [...block![1].matchAll(/(\w+): \[([^\]]*)\]/g)].map(match => [
        match[1],
        [...match[2].matchAll(/'([^']+)'/g)].map(id => id[1]),
      ]),
    )
  }

  function parseServerPresets(): Record<string, string[]> {
    const pipeline = readFileSync(
      path.join(here, '../../../server/src/services/compression/pipeline.ts'),
      'utf8',
    )
    const block = pipeline.match(/const MODE_ENGINES[^=]*= \{([\s\S]*?)\n\}/)
    expect(block, 'MODE_ENGINES not found in pipeline.ts').toBeTruthy()
    return Object.fromEntries(
      [...block![1].matchAll(/(\w+): new Set\(([\s\S]*?)\)/g)].map(match => [
        match[1],
        [...match[2].matchAll(/'([^']+)'/g)].map(id => id[1]),
      ]),
    )
  }

  it('mirrors MODE_ENGINES in the server compression pipeline', () => {
    const client = parseClientPresets()
    const server = parseServerPresets()
    expect(Object.keys(client).sort()).toEqual(['aggressive', 'lossless', 'off', 'standard'])
    for (const mode of ['lossless', 'standard', 'aggressive'] as const) {
      expect(client[mode], `mode ${mode} preset drift`).toEqual(server[mode])
    }
  })

  it('presets only reference engines the dialog renders', () => {
    const ids = [...source.matchAll(/\{ id: '([^']+)', tKey: '[^']+', lossless:/g)].map(match => match[1])
    const client = parseClientPresets()
    for (const preset of Object.values(client)) {
      for (const engine of preset) {
        expect(ids, `${engine} is not a rendered engine`).toContain(engine)
      }
    }
  })
})
