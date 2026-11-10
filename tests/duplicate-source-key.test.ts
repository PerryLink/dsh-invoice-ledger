/**
 * Regression: a ledger without invoice code/number still has a source-file
 * identity. Two rows pointing at the same original file must not collapse to
 * the empty key "|" and silently escape the duplicate check.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { check, loadPack } from '../src/engine.ts'
import type { TableJson } from 'dsh-table-ingest/api'

const pack = loadPack(readFileSync(join(import.meta.dirname, '../rules/invoice-ledger.yaml'), 'utf8'))
const table: TableJson = {
  target: 'ledger.xlsx',
  tableIndex: 0,
  headerRows: [1],
  columns: ['sourceFile', 'sha256'],
  header: {},
  rows: [
    { sourceFile: 'a.pdf', sha256: 'abc' },
    { sourceFile: 'a.pdf', sha256: 'abc' },
  ],
  warnings: [],
  mergedCells: 0,
  sections: [],
  ragged: false,
}

describe('duplicate source key', () => {
  it('detects the same original file when invoice numbers are absent', () => {
    const result = check(pack, table, '2026-11-10')
    expect(result.findings.some((finding) => finding.ruleId === 'INV-005')).toBe(true)
  })
})
