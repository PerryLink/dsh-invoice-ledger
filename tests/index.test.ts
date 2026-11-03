/**
 * Invoice ledger checks.
 *
 * Two behaviours are load-bearing:
 *
 *  - A duplicate is keyed on code + number, never on the amount, so a typo in the
 *    amount still surfaces as a duplicate.
 *  - Rules this version cannot execute are listed by name. A report that showed
 *    only findings would read as if every rule had run.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { check, loadPack, minor, money, normaliseDate } from '../src/engine.ts'
import { renderMarkdown } from '../src/report.ts'
import type { TableJson } from 'dsh-table-ingest/api'

const HERE = import.meta.dirname
const pack = loadPack(readFileSync(join(HERE, '../rules/invoice-ledger.yaml'), 'utf8'))

/** Build a table from rows of string maps. */
function table(rows: Record<string, string>[]): TableJson {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return {
    target: 'ledger.xlsx',
    tableIndex: 0,
    headerRows: [1],
    columns,
    header: {},
    rows,
    warnings: [],
    mergedCells: 0,
    sections: [],
    ragged: false,
  }
}

const TODAY = '2026-10-24'

describe('money and dates', () => {
  it('compares at two decimal places', () => {
    expect(minor('12.3')).toBe(1230n)
    expect(minor('12.30000000001')).toBe(1230n)
    expect(money(1230n)).toBe('12.30')
  })

  it('strips currency marks and thousands separators', () => {
    expect(minor('¥1,234.56')).toBe(123456n)
  })

  it('rejects text that is not a number instead of coercing to zero', () => {
    expect(minor('约一百')).toBeUndefined()
    expect(minor('')).toBeUndefined()
  })

  it('normalises the date spellings a ledger actually contains', () => {
    expect(normaliseDate('2026/1/5')).toBe('2026-01-05')
    expect(normaliseDate('2026.01.05')).toBe('2026-01-05')
    expect(normaliseDate('20260105')).toBe('2026-01-05')
    expect(normaliseDate('2026-01-05')).toBe('2026-01-05')
  })
})

describe('rule pack', () => {
  it('loads every rule and the profile', () => {
    expect(pack.rules.length).toBe(26)
    expect(pack.profile.companyName).toContain('示例')
    expect(pack.profile.roundingTolerance).toBeGreaterThan(0)
  })

  it('every rule carries a basis with a document and an excerpt', () => {
    for (const rule of pack.rules) {
      expect(rule.basis.document, `${rule.id} 缺 document`).not.toBe('')
      expect(rule.basis.excerpt.length, `${rule.id} 的 excerpt 太短`).toBeGreaterThan(8)
    }
  })

  it('separates the implemented kinds from the rest', () => {
    const result = check(pack, table([]), TODAY)
    // The report must be able to name what did not run.
    expect(result.unsupported.length).toBeGreaterThan(0)
    expect(result.unsupported.every((rule) => rule.id !== '' && rule.kind !== '')).toBe(true)
  })
})

describe('checks', () => {
  it('catches a duplicate invoice even when the amount differs', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000001', invoiceCode: '', amount: '100.00', tax: '13.00', total: '113.00', buyerName: '示例科技有限公司', claimId: 'R1' },
      { invoiceNumber: '26141200000000000001', invoiceCode: '', amount: '100.50', tax: '13.00', total: '113.50', buyerName: '示例科技有限公司', claimId: 'R2' },
    ])
    const result = check(pack, ledger, TODAY)
    const duplicate = result.findings.find((item) => item.ruleId === 'INV-006')
    expect(duplicate).toBeDefined()
    expect(duplicate?.message).toContain('2')
  })

  it('catches a total that does not equal amount plus tax', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000002', invoiceCode: '', amount: '100.00', tax: '13.00', total: '120.00', buyerName: '示例科技有限公司' },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.some((item) => item.message.includes('相差'))).toBe(true)
  })

  it('tolerates a rounding difference inside the configured tolerance', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000003', invoiceCode: '', amount: '100.00', tax: '13.00', total: '113.01', buyerName: '示例科技有限公司' },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.some((item) => item.message.includes('相差'))).toBe(false)
  })

  it('flags a buyer that is not the company', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000004', invoiceCode: '', amount: '10', tax: '0', total: '10', buyerName: '别的公司' },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.some((item) => item.message.includes('不是本公司'))).toBe(true)
  })

  it('accepts a registered branch', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000005', invoiceCode: '', amount: '10', tax: '0', total: '10', buyerName: '示例科技上海分公司' },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.some((item) => item.message.includes('不是本公司'))).toBe(false)
  })

  it('resolves our own tax id from the profile instead of comparing against the template', () => {
    // `${profile.company.taxId}` used to be resolved to its own literal text,
    // so the company's real tax id was reported as "not this company".
    const ledger = table([
      {
        invoiceNumber: '26141200000000000010',
        invoiceCode: '',
        amount: '10',
        tax: '0',
        total: '10',
        buyerName: '示例科技有限公司',
        buyerTaxId: '91110108MA01ABCDEF',
      },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.filter((item) => item.ruleId === 'INV-009')).toHaveLength(0)
  })

  it('resolves the company name used in the mismatch report', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000011', invoiceCode: '', amount: '10', tax: '0', total: '10', buyerName: '别的公司', buyerTaxId: '91110108MA01ABCDEF' },
    ])
    const result = check(pack, ledger, TODAY)
    const finding = result.findings.find((item) => item.ruleId === 'INV-009')
    expect(finding?.expected).toBe('示例科技有限公司')
  })

  it('enforces companyStartDate as the earliest allowed issue date', () => {
    const ledgerOf = (issueDate: string, invoiceNumber: string): TableJson =>
      table([
        {
          invoiceNumber,
          invoiceCode: '',
          docType: 'vat_ne',
          issueDate,
          amount: '10',
          tax: '0',
          total: '10',
          buyerName: '示例科技有限公司',
          buyerTaxId: '91110108MA01ABCDEF',
        },
      ])
    const before = check(pack, ledgerOf('2014-06-01', '14141200000000000012'), TODAY)
    const finding = before.findings.find((item) => item.ruleId === 'INV-002' && item.message.includes('早于'))
    expect(finding).toBeDefined()
    expect(finding?.message).toContain('2015-01-01')
    // The lower bound is inclusive: an invoice on the start date is allowed.
    const atBoundary = check(pack, ledgerOf('2015-01-01', '15141200000000000012'), TODAY)
    expect(atBoundary.findings.some((item) => item.ruleId === 'INV-002' && item.message.includes('早于'))).toBe(false)
  })

  it('does not compare a seller name or tax id with our own company', () => {
    // The seller is the counterparty in this ledger. Comparing it with the
    // company master data reported every real seller as "not this company".
    const ledger = table([
      {
        invoiceNumber: '26141200000000000013',
        invoiceCode: '',
        amount: '10',
        tax: '0',
        total: '10',
        buyerName: '示例科技有限公司',
        buyerTaxId: '91110108MA01ABCDEF',
        sellerName: '北京华信贸易有限公司',
        sellerTaxId: '91110108MA01234567',
      },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.filter((item) => item.ruleId === 'INV-010')).toHaveLength(0)
  })

  it('still reports an empty seller name when the column is present', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000014', invoiceCode: '', amount: '10', tax: '0', total: '10', buyerName: '示例科技有限公司', sellerName: '' },
    ])
    const result = check(pack, ledger, TODAY)
    const finding = result.findings.find((item) => item.ruleId === 'INV-010')
    expect(finding?.message).toContain('sellerName 为空')
    expect(finding?.severities).toBe('warn')
  })

  it('flags a future invoice date', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000006', invoiceCode: '', amount: '10', tax: '0', total: '10', buyerName: '示例科技有限公司', issueDate: '2027-01-01' },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.some((item) => item.message.includes('晚于今天'))).toBe(true)
  })

  it('does not mistake a 20-digit number for a placeholder', () => {
    // The pack's placeholder patterns include runs of zeros; unanchored, a real
    // 数电票 sequential code would match and every invoice would be flagged.
    const ledger = table([
      { invoiceNumber: '26141200000000000007', invoiceCode: '', amount: '10', tax: '0', total: '10', buyerName: '示例科技有限公司' },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.some((item) => item.message.includes('模板占位'))).toBe(false)
  })

  it('flags template placeholder text left in a cell', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000007', invoiceCode: '', amount: '10', tax: '0', total: '10', buyerName: '示例科技有限公司', sellerName: 'XX公司' },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.some((item) => item.message.includes('模板占位'))).toBe(true)
  })

  it('flags a 20-digit number whose year prefix disagrees with the issue date', () => {
    const ledger = table([
      // 27 prefix but issued in 2026.
      { invoiceNumber: '27141200000000000008', invoiceCode: '', amount: '10', tax: '0', total: '10', buyerName: '示例科技有限公司', issueDate: '2026-10-01', docType: 'vat_ne' },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.some((item) => item.message.includes('年度前缀'))).toBe(true)
  })
})

describe('report', () => {
  it('lists what did not run, before what did', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000009', invoiceCode: '', amount: '10', tax: '0', total: '10', buyerName: '别的公司' },
    ])
    const result = check(pack, ledger, TODAY)
    const markdown = renderMarkdown(result, 'ledger.xlsx', pack.version)
    expect(markdown).toContain('未执行的规则（不代表通过）')
    const unsupportedAt = markdown.indexOf('未执行的规则')
    const findingsAt = markdown.indexOf('## 异常清单')
    expect(unsupportedAt).toBeGreaterThan(-1)
    expect(findingsAt === -1 || unsupportedAt < findingsAt).toBe(true)
    expect(markdown).toContain('未执行的规则不等于通过')
  })
})
