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
    // The report must be able to name what did not run, whether because the
    // engine cannot do it or because it needs external data / a human.
    expect(result.manual.length).toBeGreaterThan(0)
    expect([...result.manual, ...result.unsupported].every((rule) => rule.id !== '' && rule.kind !== '')).toBe(true)
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
    expect(markdown).toContain('需要人工/外部数据（本工具不执行）')
    const manualAt = markdown.indexOf('需要人工/外部数据')
    const findingsAt = markdown.indexOf('## 异常清单')
    expect(manualAt).toBeGreaterThan(-1)
    expect(findingsAt === -1 || manualAt < findingsAt).toBe(true)
    expect(markdown).toContain('人工 1 条')
  })
})

describe('line-level arithmetic (INV-013 / INV-014)', () => {
  const header = { invoiceNumber: '26141200000000000011', invoiceCode: '4410', issueDate: '2026-10-08', buyerName: '示例科技有限公司' }

  it('reports detail lines whose sum does not match the invoice total', () => {
    const ledger = table([
      { ...header, lineAmount: '60.00', lineTax: '7.80', amount: '100.00', tax: '13.00', total: '113.00' },
      { ...header, lineAmount: '50.00', lineTax: '6.50', amount: '100.00', tax: '13.00', total: '113.00' },
    ])
    const result = check(pack, ledger, TODAY)
    const hit = result.findings.find((item) => item.ruleId === 'INV-013')
    expect(hit).toBeDefined()
    expect(hit?.message).toContain('100.00')
    expect(hit?.message).toContain('110.00')
  })

  it('keeps a matching detail sum quiet and counts the rule as executed', () => {
    const ledger = table([
      { ...header, lineAmount: '60.00', lineTax: '7.80', amount: '100.00', tax: '13.00', total: '113.00' },
      { ...header, lineAmount: '40.00', lineTax: '5.20', amount: '100.00', tax: '13.00', total: '113.00' },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-013')).toBe(false)
    expect(result.skipped.some((item) => item.id === 'INV-013')).toBe(false)
  })

  it('skips INV-013 by name when the ledger has no detail columns', () => {
    const ledger = table([{ ...header, amount: '100.00', tax: '13.00', total: '113.00' }])
    const result = check(pack, ledger, TODAY)
    const skip = result.skipped.find((item) => item.id === 'INV-013')
    expect(skip?.reason).toContain('lineAmount')
    expect(result.summary.skipped).toBeGreaterThan(0)
  })

  it('flags quantity times unit price, and rounds the product once', () => {
    const bad = check(pack, table([
      { ...header, invoiceNumber: '26141200000000000012', quantity: '2', unitPrice: '3.33', lineAmount: '7.00', unit: '件' },
    ]), TODAY)
    expect(bad.findings.some((item) => item.ruleId === 'INV-014')).toBe(true)

    // 0.333 × 3 = 0.999 → 1.00 after one half-up rounding; truncation would say 0.99.
    const rounded = check(pack, table([
      { ...header, invoiceNumber: '26141200000000000013', quantity: '0.333', unitPrice: '3', lineAmount: '1.00', unit: '千克' },
    ]), TODAY)
    expect(rounded.findings.some((item) => item.ruleId === 'INV-014')).toBe(false)
  })

  it('skips a line sold by the job rather than inventing a unit price', () => {
    const result = check(pack, table([
      { ...header, invoiceNumber: '26141200000000000014', quantity: '1', unitPrice: '999', lineAmount: '500.00', unit: '批' },
    ]), TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-014')).toBe(false)
  })
})

describe('executed / skipped / unsupported partition', () => {
  it('accounts for every rule in the pack exactly once', () => {
    const ledger = table([
      { invoiceNumber: '26141200000000000001', invoiceCode: '', issueDate: '2026-10-08', amount: '100.00', tax: '13.00', total: '113.00', buyerName: '示例科技有限公司' },
    ])
    const result = check(pack, ledger, TODAY)
    expect(result.summary.total).toBe(pack.rules.length)
    expect(result.summary.executed + result.summary.skipped + result.summary.manual + result.summary.unsupported).toBe(pack.rules.length)
    const named = new Set([
      ...result.unsupported.map((item) => item.id),
      ...result.skipped.map((item) => item.id),
      ...result.manual.map((item) => item.id),
    ])
    for (const rule of pack.rules) {
      if (named.has(rule.id)) continue
      expect(result.summary.executed, `${rule.id} 既没执行也没被点名`).toBeGreaterThan(0)
    }
  })

  it('never lists the same rule as both skipped and unsupported', () => {
    const result = check(pack, table([]), TODAY)
    const skipped = new Set(result.skipped.map((item) => item.id))
    expect(result.unsupported.some((item) => skipped.has(item.id))).toBe(false)
    expect(result.summary.executed + result.summary.skipped + result.summary.manual + result.summary.unsupported).toBe(pack.rules.length)
  })
})

describe('form totals and tax arithmetic (INV-004 / INV-012 / INV-019)', () => {
  const row = (extra: Record<string, string>) => ({
    invoiceNumber: '26141200000000000021', invoiceCode: '4410', issueDate: '2026-10-08',
    buyerName: '示例科技有限公司', amount: '100.00', tax: '13.00', total: '113.00',
    ...extra,
  })

  it('matches a reimbursement form to its invoice total', () => {
    const result = check(pack, table([row({ formNo: 'BX-1', formAmount: '113.00' })]), TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-019')).toBe(false)
  })

  it('reports a form that claims more than its invoices', () => {
    const result = check(pack, table([row({ formNo: 'BX-1', formAmount: '120.00' })]), TODAY)
    const hit = result.findings.find((item) => item.ruleId === 'INV-019')
    expect(hit?.severities).toBe('error')
  })

  it('reports partial reimbursement at its configured severity', () => {
    const result = check(pack, table([row({ formNo: 'BX-1', formAmount: '100.00' })]), TODAY)
    const hit = result.findings.find((item) => item.ruleId === 'INV-019')
    expect(hit?.severities).toBe('info')
  })

  it('recomputes tax from amount and rate', () => {
    expect(check(pack, table([row({ taxRate: '13%', tax: '13.00' })]), TODAY).findings.some((item) => item.ruleId === 'INV-004')).toBe(false)
    expect(check(pack, table([row({ taxRate: '13%', tax: '12.00' })]), TODAY).findings.some((item) => item.ruleId === 'INV-004')).toBe(true)
    expect(check(pack, table([row({ taxRate: '免税', tax: '13.00' })]), TODAY).findings.some((item) => item.ruleId === 'INV-004')).toBe(false)
  })

  it('flags a zero tax with a non-exempt rate and a non-zero tax with an exempt rate', () => {
    expect(check(pack, table([row({ taxRate: '13%', tax: '0.00' })]), TODAY).findings.some((item) => item.ruleId === 'INV-012')).toBe(true)
    expect(check(pack, table([row({ taxRate: '免税', tax: '5.00' })]), TODAY).findings.some((item) => item.ruleId === 'INV-012')).toBe(true)
    expect(check(pack, table([row({ taxRate: '13%', tax: '13.00' })]), TODAY).findings.some((item) => item.ruleId === 'INV-012')).toBe(false)
  })
})

describe('age, numeric range and concentration (INV-015/016/018/023)', () => {
  const base = (extra: Record<string, string> = {}) => ({
    invoiceNumber: '26141200000000000021', invoiceCode: '4410', issueDate: '2026-10-08',
    sellerTaxId: '91440000MA00000001', buyerTaxId: '91440000MA00000002',
    buyerName: '示例科技有限公司', sellerName: '示例供应商', amount: '100.00', tax: '13.00', total: '113.00',
    ...extra,
  })

  it('reminds when an invoice is older than the configured years', () => {
    const old = check(pack, table([base({ issueDate: '2020-01-01' })]), TODAY)
    expect(old.findings.some((item) => item.ruleId === 'INV-018')).toBe(true)
    const fresh = check(pack, table([base()]), TODAY)
    expect(fresh.findings.some((item) => item.ruleId === 'INV-018')).toBe(false)
  })

  it('flags zero, unexplained negative and out-of-range values', () => {
    expect(check(pack, table([base({ total: '0.00' })]), TODAY).findings.some((item) => item.ruleId === 'INV-023')).toBe(true)
    const negative = check(pack, table([base({ total: '-113.00' })]), TODAY)
    expect(negative.findings.find((item) => item.ruleId === 'INV-023')?.severities).toBe('error')
    const red = check(pack, table([base({ total: '-113.00', redLetter: 'true' })]), TODAY)
    expect(red.findings.some((item) => item.ruleId === 'INV-023' && item.message.includes('负数'))).toBe(false)
    expect(check(pack, table([base({ taxRate: '20%' })]), TODAY).findings.some((item) => item.ruleId === 'INV-023')).toBe(true)
  })

  it('reports a same-seller same-buyer same-day group at the threshold', () => {
    const rows = Array.from({ length: 10 }, (_, index) => base({ invoiceNumber: `261412000000000000${10 + index}` }))
    const result = check(pack, table(rows), TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-016')).toBe(true)
    const below = check(pack, table(rows.slice(0, 9)), TODAY)
    expect(below.findings.some((item) => item.ruleId === 'INV-016')).toBe(false)
  })
})

describe('consecutive invoice runs (INV-015)', () => {
  const row = (number: string, seller = '示例供应商') => ({
    invoiceNumber: number, invoiceCode: '4410', issueDate: '2026-10-08',
    sellerTaxId: '91440000MA00000001', sellerName: seller,
    buyerTaxId: '91440000MA00000002', buyerName: '示例科技有限公司',
    amount: '100.00', tax: '13.00', total: '113.00',
  })

  it('reports a run of three consecutive numbers', () => {
    const rows = ['26141200000000000021', '26141200000000000022', '26141200000000000023'].map((n) => row(n))
    const result = check(pack, table(rows), TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-015')).toBe(true)
  })

  it('does not report two numbers or a gap larger than maxGap', () => {
    const two = ['26141200000000000021', '26141200000000000022'].map((n) => row(n))
    expect(check(pack, table(two), TODAY).findings.some((item) => item.ruleId === 'INV-015')).toBe(false)
    const gap = ['26141200000000000021', '26141200000000000022', '26141200000000000030'].map((n) => row(n))
    expect(check(pack, table(gap), TODAY).findings.some((item) => item.ruleId === 'INV-015')).toBe(false)
  })

  it('skips high-volume sellers', () => {
    const rows = ['26141200000000000021', '26141200000000000022', '26141200000000000023'].map((n) => row(n, '中国石化'))
    expect(check(pack, table(rows), TODAY).findings.some((item) => item.ruleId === 'INV-015')).toBe(false)
  })
})

describe('rate vs item category (INV-011)', () => {
  const row = (extra: Record<string, string> = {}) => ({
    invoiceNumber: '26141200000000000031', invoiceCode: '4410', issueDate: '2026-10-08',
    buyerName: '示例科技有限公司', itemName: '餐饮服务', amount: '100.00', tax: '13.00', total: '113.00',
    taxRate: '13%', ...extra,
  })

  it('flags a rate that is impossible for the declared category', () => {
    const result = check(pack, table([row()]), TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-011')).toBe(true)
  })

  it('accepts a plausible rate and a small-scale exception', () => {
    expect(check(pack, table([row({ taxRate: '6%', tax: '6.00', total: '106.00' })]), TODAY).findings.some((item) => item.ruleId === 'INV-011')).toBe(false)
    expect(check(pack, table([row({ taxRate: '1%', tax: '1.00', total: '101.00' })]), TODAY).findings.some((item) => item.ruleId === 'INV-011')).toBe(false)
  })
})

describe('file hashes and source links (INV-007 / INV-024)', () => {
  const row = (extra: Record<string, string> = {}) => ({
    invoiceNumber: '26141200000000000041', invoiceCode: '4410', issueDate: '2026-10-08',
    buyerName: '示例科技有限公司', amount: '100.00', tax: '13.00', total: '113.00', ...extra,
  })

  it('flags one file hash attached to different invoice keys', () => {
    const result = check(pack, table([
      row({ invoiceNumber: '26141200000000000041', sha256: 'a'.repeat(64) }),
      row({ invoiceNumber: '26141200000000000042', sha256: 'a'.repeat(64) }),
    ]), TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-007')).toBe(true)
  })

  it('flags a missing source file when the column is present', () => {
    const result = check(pack, table([row({ sourceFile: 'definitely-missing.pdf' })]), TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-024')).toBe(true)
  })

  it('skips the rule when neither hash nor source column is present', () => {
    const result = check(pack, table([row()]), TODAY)
    expect(result.skipped.some((item) => item.id === 'INV-007' || item.id === 'INV-024')).toBe(true)
  })
})

describe('red-letter linkage (INV-008)', () => {
  const blue = (extra: Record<string, string> = {}) => ({
    invoiceNumber: '26141200000000000051', invoiceCode: '4410', issueDate: '2026-10-08',
    sellerTaxId: '91440000MA00000001', buyerTaxId: '91440000MA00000002',
    buyerName: '示例科技有限公司', amount: '100.00', tax: '13.00', total: '113.00', ...extra,
  })

  it('accepts a red invoice linked to a blue invoice within its amount', () => {
    const rows = [blue(), blue({ invoiceNumber: '26141200000000000052', isRed: 'true', originalInvoiceNumber: '26141200000000000051', total: '-50.00' })]
    const result = check(pack, table(rows), TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-008' && item.severities === 'warn')).toBe(false)
  })

  it('flags a red total that exceeds the blue invoice', () => {
    const rows = [blue(), blue({ invoiceNumber: '26141200000000000052', isRed: 'true', originalInvoiceNumber: '26141200000000000051', total: '-200.00' })]
    const result = check(pack, table(rows), TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-008' && item.severities === 'warn')).toBe(true)
  })

  it('marks an inferred link as info, not as confirmed', () => {
    const rows = [blue(), blue({ invoiceNumber: '26141200000000000052', isRed: 'true', total: '-113.00' })]
    const result = check(pack, table(rows), TODAY)
    expect(result.findings.some((item) => item.ruleId === 'INV-008' && item.message.includes('推定关联'))).toBe(true)
  })

  it('skips when the ledger has no red-letter column values', () => {
    const result = check(pack, table([blue()]), TODAY)
    expect(result.skipped.some((item) => item.id === 'INV-008')).toBe(true)
  })
})
