/**
 * Folder-level runner for the invoice ledger.
 *
 * The single-file tool is the review surface; this runner is the job surface. It
 * walks a directory, runs the same rule pack against every ledger it can read,
 * and returns one aggregate instead of making the caller loop. It deliberately
 * does not merge the files' rules: each file is checked on its own, so a finding
 * always names the file it came from.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { ingestToTable } from 'dsh-table-ingest/api'
import { check, loadPack } from './engine.ts'
import { resolvePackageFile } from './index.ts'
import { renderMarkdown } from './report.ts'

/** Extensions the runner will try to read as a ledger. */
const LEDGER_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.csv', '.tsv', '.json', '.yaml', '.yml'])

/** One file's outcome, kept even when it failed so the batch is auditable. */
export interface BatchFileResult {
  file: string
  ok: boolean
  findings?: number
  errors?: number
  warnings?: number
  infos?: number
  error?: string
}

/** Aggregate result for a directory. */
export interface BatchResult {
  dir: string
  checkedAt: string
  rulesetVersion: string
  files: BatchFileResult[]
  totals: {
    files: number
    ok: number
    failed: number
    findings: number
    errors: number
    warnings: number
    infos: number
  }
  markdown: string
  json: string
}

/** Options for {@link runBatch}. */
export interface BatchOptions {
  /** Directory to scan. */
  dir: string
  /** `YYYY-MM-DD` used for date-sensitive checks; defaults to today. */
  today?: string
  /** Rule-pack path, resolved like the single-file tool. */
  rulesFile?: string
  /** Recurse into subdirectories. */
  recursive?: boolean
  /** Write the aggregate JSON here as well as returning it. */
  outFile?: string
}

async function listLedgers(dir: string, recursive: boolean): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recursive) out.push(...(await listLedgers(path, recursive)))
      continue
    }
    if (LEDGER_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(path)
  }
  return out.sort()
}

/**
 * Run the invoice rules over every ledger in a directory.
 *
 * @param options - directory, clock and rule pack.
 * @returns per-file results, totals, and a Markdown/JSON summary.
 */
export async function runBatch(options: BatchOptions): Promise<BatchResult> {
  const dir = resolve(options.dir)
  const rulesPath = resolvePackageFile(options.rulesFile?.trim() || 'rules/invoice-ledger.yaml')
  const pack = loadPack(await readFile(rulesPath, 'utf8'))
  const today = options.today?.trim() || new Date().toISOString().slice(0, 10)
  const files = await listLedgers(dir, options.recursive === true)
  const results: BatchFileResult[] = []

  for (const file of files) {
    try {
      const buffer = await readFile(file)
      const ingested = ingestToTable(buffer, file)
      if (!ingested.ok || ingested.table === undefined) {
        results.push({ file, ok: false, error: ingested.error ?? '无法抽出表格' })
        continue
      }
      const result = check(pack, ingested.table, today)
      results.push({
        file,
        ok: true,
        findings: result.findings.length,
        errors: result.summary.errors,
        warnings: result.summary.warnings,
        infos: result.summary.infos,
      })
    } catch (error) {
      results.push({ file, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const totals = {
    files: results.length,
    ok: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    findings: results.reduce((sum, item) => sum + (item.findings ?? 0), 0),
    errors: results.reduce((sum, item) => sum + (item.errors ?? 0), 0),
    warnings: results.reduce((sum, item) => sum + (item.warnings ?? 0), 0),
    infos: results.reduce((sum, item) => sum + (item.infos ?? 0), 0),
  }

  const lines: string[] = []
  lines.push('# 发票台账批量检查')
  lines.push('')
  lines.push(`- 目录：${dir}`)
  lines.push(`- 检查时间：${new Date().toISOString()}`)
  lines.push(`- 规则集版本：${pack.version}`)
  lines.push(`- 文件：${totals.files}（成功 ${totals.ok} · 失败 ${totals.failed}）`)
  lines.push(`- 统计：错误 ${totals.errors} · 提示 ${totals.warnings} · 参考 ${totals.infos}`)
  lines.push('')
  lines.push('| 文件 | 结果 | 错误 | 提示 | 参考 |')
  lines.push('|---|---|---:|---:|---:|')
  for (const item of results) {
    lines.push(`| ${item.file} | ${item.ok ? 'OK' : `FAIL：${item.error ?? ''}`} | ${item.errors ?? 0} | ${item.warnings ?? 0} | ${item.infos ?? 0} |`)
  }
  lines.push('')
  lines.push('> 批量结果只汇总每个文件各自的检查；未在单个文件中执行的规则仍不产生结论。')

  const json = JSON.stringify({ dir, today, rulesetVersion: pack.version, files: results, totals }, null, 2)
  if (options.outFile !== undefined && options.outFile.trim() !== '') await writeFile(resolve(options.outFile), json)
  return { dir, checkedAt: new Date().toISOString(), rulesetVersion: pack.version, files: results, totals, markdown: lines.join('\n'), json }
}

export { renderMarkdown }
