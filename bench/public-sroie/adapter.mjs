#!/usr/bin/env node
/**
 * Adapt SROIE receipt keys to the invoice ledger shape.
 *
 * Only the fields SROIE actually has are mapped: sellerName=company,
 * issueDate=date (converted to YYYY-MM-DD), total=total. No invoice number,
 * tax amount, buyer, tax rate or line item is invented.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function isoDate(value) {
  const match = String(value ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!match) return ''
  const [, day, month, year] = match
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

export function buildRows(dir = join(here, '.data')) {
  return readdirSync(dir).filter((name) => /^\d{3}\.json$/u.test(name)).sort().map((name, index) => {
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    return {
      caseId: `sroie-${name.replace('.json', '')}`,
      sellerName: String(record.company ?? ''),
      issueDate: isoDate(record.date),
      total: String(record.total ?? ''),
      row: index + 1,
    }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? join(here, 'cases.json')
  const rows = buildRows()
  writeFileSync(out, JSON.stringify({ rows }, null, 2) + '\n')
  console.log(`wrote ${out}: ${rows.length} rows`)
}
