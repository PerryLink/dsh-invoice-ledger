import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runBatch } from '../src/batch.ts'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'invoice-batch-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const sample = readFile(join(import.meta.dirname, '..', 'samples', 'quickstart', 'input', 'invoices.csv'), 'utf8')

describe('folder-level invoice batch', () => {
  it('runs every ledger and aggregates the totals', async () => {
    const dir = await temp()
    await writeFile(join(dir, 'a.csv'), await sample)
    await writeFile(join(dir, 'b.csv'), await sample)
    const result = await runBatch({ dir, today: '2026-10-15' })
    expect(result.totals.files).toBe(2)
    expect(result.totals.ok).toBe(2)
    expect(result.totals.findings).toBe(6)
    expect(result.markdown).toContain('a.csv | OK')
  })

  it('keeps a bad file as a failure instead of aborting the folder', async () => {
    const dir = await temp()
    await writeFile(join(dir, 'good.csv'), await sample)
    await writeFile(join(dir, 'bad.xlsx'), 'not a zip')

    const result = await runBatch({ dir, today: '2026-10-15' })
    expect(result.totals.files).toBe(2)
    expect(result.totals.ok).toBe(1)
    expect(result.totals.failed).toBe(1)
    expect(result.files.find((item) => item.file.endsWith('bad.xlsx'))?.ok).toBe(false)
  })

  it('writes the aggregate JSON when asked', async () => {
    const dir = await temp()
    await writeFile(join(dir, 'a.csv'), await sample)
    const out = join(dir, 'result.json')
    const result = await runBatch({ dir, today: '2026-10-15', outFile: out })
    const written = JSON.parse(await readFile(out, 'utf8')) as { totals: { files: number } }
    expect(written.totals.files).toBe(1)
    expect(result.json).toContain('"files": 1')
  })

  it('recurses only when asked', async () => {
    const dir = await temp()
    const nested = join(dir, 'nested')
    await writeFile(join(dir, 'a.csv'), await sample)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(nested))
    await writeFile(join(nested, 'b.csv'), await sample)
    expect((await runBatch({ dir, today: '2026-10-15' })).totals.files).toBe(1)
    expect((await runBatch({ dir, today: '2026-10-15', recursive: true })).totals.files).toBe(2)
  })
})
