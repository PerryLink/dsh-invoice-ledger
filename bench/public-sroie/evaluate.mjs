#!/usr/bin/env node
/**
 * End-to-end public SROIE benchmark for dsh-invoice-ledger.
 *
 * The keys are public MIT-licensed SROIE annotations. Only sellerName,
 * issueDate and total exist; rules needing invoice number, tax, buyer or line
 * items are excluded, not faked.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../../lib/index.mjs'
import { buildRows } from './adapter.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const rows = buildRows()
const registered = []
plugin.apply({ tools: { register: (tool) => { registered.push(tool); return () => {} } } }, plugin.Config ? plugin.Config({}) : {})
const tool = registered.find((item) => item.name === plugin.TOOL_NAME)
if (!tool) throw new Error('invoice tool not registered')

const root = await mkdtemp(join(tmpdir(), 'dsh-sroie-'))
function csv(items) {
  return ['caseId,sellerName,issueDate,total', ...items.map((row) => [row.caseId, row.sellerName, row.issueDate, row.total].join(','))].join('\n') + '\n'
}
async function run(items) {
  const dir = await mkdtemp(join(root, 'case-'))
  const file = join(dir, 'ledger.csv')
  await writeFile(file, csv(items))
  const result = await tool.execute({ file, today: '2026-11-10', outFile: join(dir, 'anomalies.xlsx') }, { signal: new AbortController().signal })
  const parsed = JSON.parse(result.resultJson)
  return new Set((parsed.findings ?? []).map((finding) => finding.ruleId))
}

const variants = {
  clean: (row) => ({ ...row }),
  future_date: (row) => ({ ...row, issueDate: '2099-01-01' }),
  bad_date: (row) => ({ ...row, issueDate: 'not-a-date' }),
  negative_total: (row) => ({ ...row, total: '-100.00' }),
  zero_total: (row) => ({ ...row, total: '0.00' }),
}
const byRule = { 'INV-002': { tp: 0, fp: 0, fn: 0, tn: 0 }, 'INV-023': { tp: 0, fp: 0, fn: 0, tn: 0 } }
for (const [kind, mutate] of Object.entries(variants)) {
  for (const row of rows) {
    const findings = await run([mutate(row)])
    const target = kind === 'future_date' || kind === 'bad_date' ? 'INV-002' : kind === 'negative_total' || kind === 'zero_total' ? 'INV-023' : null
    for (const rule of Object.keys(byRule)) {
      const fired = findings.has(rule)
      if (target === rule) {
        if (fired) byRule[rule].tp += 1
        else byRule[rule].fn += 1
      } else if (fired) {
        byRule[rule].fp += 1
      } else {
        byRule[rule].tn += 1
      }
    }
  }
}
for (const rule of Object.keys(byRule)) {
  const e = byRule[rule]
  e.precision = e.tp + e.fp === 0 ? null : e.tp / (e.tp + e.fp)
  e.recall = e.tp + e.fn === 0 ? null : e.tp / (e.tp + e.fn)
}
const summary = {
  dataset: 'SROIE receipt keys (MIT)',
  source: 'https://github.com/zzzDavid/ICDAR-2019-SROIE',
  license: 'MIT',
  rows: rows.length,
  generatedAt: new Date().toISOString(),
  byRule,
  limitations: [
    'SROIE has no invoice code/number, tax amount, tax rate, buyer or line items; those rules are excluded.',
    'SROIE receipts are Malaysian, not Chinese VAT invoices.',
    'The date/amount defects are injected; clean rows are real public annotations.',
  ],
}
await writeFile(join(here, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
for (const [rule, e] of Object.entries(byRule)) console.log(`${rule}: TP ${e.tp} FP ${e.fp} FN ${e.fn} TN ${e.tn} P ${e.precision?.toFixed(3)} R ${e.recall?.toFixed(3)}`)
