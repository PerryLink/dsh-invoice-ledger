/**
 * Regression: a rule whose declared fields are all absent must be reported as
 * skipped, not counted as an executed-clean check.
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
  columns: ['amount', 'tax', 'total'],
  header: {},
  rows: [{ amount: '100.00', tax: '13.00', total: '113.00' }],
  warnings: [],
  mergedCells: 0,
  sections: [],
  ragged: false,
}

describe('required-field skip', () => {
  it('skips a rule whose fields are absent instead of counting it executed', () => {
    const result = check(pack, table, '2026-11-10')
    expect(result.skipped.some((entry) => entry.id === 'INV-001')).toBe(true)
  })
})
