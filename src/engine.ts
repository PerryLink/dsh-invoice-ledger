/**
 * Invoice-ledger checks.
 *
 * The rule pack declares `params.check.kind` per rule; this module implements the
 * kinds and reports the rest as not implemented *by name*, so a ledger that passes
 * the implemented checks never reads as if every rule ran.
 *
 * Money is compared as integer minor units. A 20-digit 数电票 number is kept as a
 * string throughout: it exceeds `Number.MAX_SAFE_INTEGER`, and converting it to a
 * number silently loses the last digits — which for a duplicate check means two
 * different invoices look identical.
 */

import type { TableJson } from 'dsh-table-ingest/api'
import { parseYaml } from './shared/yaml.ts'

/** One rule from the pack. */
export interface LedgerRule {
  id: string
  title: string
  severity: 'error' | 'warn' | 'info'
  basis: { document: string; number: string; clause: string; excerpt: string; kind: string; source: string }
  check: Record<string, unknown> & { kind: string }
  note: string
}

/** The `profile` block: what "our company" means and the tunables. */
export interface LedgerProfile {
  companyName: string
  companyTaxId: string
  aliases: string[]
  entities: { name: string; taxId: string }[]
  /** Earliest date the company could have received an invoice (`YYYY-MM-DD`). */
  companyStartDate: string
  period: string
  amountTolerance: number
  roundingTolerance: number
  lineTolerance: number
  internalSubmitDays: number
  largeAmountThreshold: number
  sameSellerDailyThreshold: number
  sequence: { minRun: number; maxGap: number; windowDays: number; highVolumeSellers: string[] }
}

/** A loaded rule pack. */
export interface LedgerPack {
  version: string
  profile: LedgerProfile
  rules: LedgerRule[]
}

/** One finding. */
export interface LedgerFinding {
  ruleId: string
  severities: 'error' | 'warn' | 'info'
  /** Row ordinal in the ledger, 1-based excluding the header; 0 for ledger-wide. */
  row: number
  /** Invoice number, when the finding concerns one invoice. */
  invoiceNumber: string
  /** What is wrong, in one sentence. */
  message: string
  /** The values involved. */
  actual: string
  /** What would be expected. */
  expected: string
  /** Suggested next step. */
  suggestion: string
  /** Citation lines from the pack. */
  basis: string
}

/** Rules the pack declares but this version cannot execute. */
export interface UnsupportedRule {
  id: string
  title: string
  kind: string
}

/**
 * A rule that ran but had nothing to measure on this ledger.
 *
 * Kept separate from `unsupported` and from `findings` because the three states
 * mean different things: "cannot run at all", "ran and found nothing", and
 * "ran but the data it needs is absent". Collapsing a skip into a pass is how a
 * report ends up claiming a check that never happened.
 */
export interface SkippedRule {
  id: string
  title: string
  kind: string
  reason: string
}

/** The whole result. */
export interface LedgerResult {
  findings: LedgerFinding[]
  unsupported: UnsupportedRule[]
  skipped: SkippedRule[]
  summary: {
    rows: number
    errors: number
    warnings: number
    infos: number
    /** Rules the pack declares. */
    total: number
    /** Rules whose check ran to completion (whether or not they found anything). */
    executed: number
    /** Rules that ran but had no data to measure. */
    skipped: number
    /** Rules with no implementation. */
    unsupported: number
  }
  warnings: string[]
}

/** Raised when the pack or the ledger cannot be used. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerError'
  }
}

/**
 * Parse a money string into integer minor units.
 *
 * @param text - e.g. `1,234.56`, `¥12`, ``.
 * @param scale - decimal places.
 * @returns minor units, or undefined when the text is not a number.
 */
export function minor(text: string | undefined, scale = 2): bigint | undefined {
  if (text === undefined) return undefined
  const cleaned = text.replace(/[\s,，¥￥]/gu, '')
  if (cleaned === '' || !/^-?\d*(?:\.\d*)?$/u.test(cleaned)) return undefined
  const negative = cleaned.startsWith('-')
  const unsigned = negative ? cleaned.slice(1) : cleaned
  const [whole = '0', frac = ''] = unsigned.split('.')
  const digits = `${whole === '' ? '0' : whole}${(frac + '0'.repeat(scale)).slice(0, scale)}`
  const value = BigInt(digits)
  return negative ? -value : value
}

/** Render minor units back to a decimal string. */
export function money(value: bigint, scale = 2): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  return `${negative ? '-' : ''}${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`
}

/**
 * Parse a decimal to `scale` places, rounding half away from zero.
 *
 * `minor()` truncates, which is right for money already written to two places but
 * wrong for a quantity of `2.3456` or a unit price: truncating before the
 * multiplication biases every product downwards and turns a correct invoice into a
 * finding. This keeps the extra digits, and the rounding happens once, on the
 * result.
 *
 * @param text - e.g. `2.5`, `1,000`, ``.
 * @param scale - decimal places to keep.
 * @returns the scaled integer, or undefined when the text is not a number.
 */
export function scaled(text: string | undefined, scale: number): bigint | undefined {
  if (text === undefined) return undefined
  const cleaned = text.replace(/[\s,，¥￥]/gu, '')
  if (cleaned === '' || !/^-?\d*(?:\.\d*)?$/u.test(cleaned)) return undefined
  const negative = cleaned.startsWith('-')
  const unsigned = negative ? cleaned.slice(1) : cleaned
  const [whole = '0', frac = ''] = unsigned.split('.')
  const padded = (frac + '0'.repeat(scale + 1)).slice(0, scale + 1)
  const keep = padded.slice(0, scale)
  const next = Number(padded[scale] ?? '0')
  let value = BigInt(`${whole === '' ? '0' : whole}${keep}`)
  if (next >= 5) value += 1n
  return negative ? -value : value
}

/** Move a scaled integer from one scale to another, rounding half away from zero. */
export function rescale(value: bigint, from: number, to: number): bigint {
  if (from === to) return value
  const factor = 10n ** BigInt(from - to)
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const rounded = (magnitude + factor / 2n) / factor
  return negative ? -rounded : rounded
}

/**
 * Parse a tax rate cell into a fraction.
 *
 * Accepts `13%`, `13％`, `0.13` and `13`; values greater than 1 are treated as
 * percent, because a VAT rate written as `13` means 13%, not 1300%. Returns
 * undefined for a missing or non-numeric cell so the caller can skip rather than
 * guess.
 */
function parseRate(text: string): number | undefined {
  const cleaned = text.replace(/[\s,，%％]/gu, '')
  if (cleaned === '' || !/^-?\d*(?:\.\d*)?$/u.test(cleaned)) return undefined
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return undefined
  return Math.abs(value) > 1 ? value / 100 : value
}

/** Normalise a rate label for the exempt/skip vocabularies. */
function rateLabel(text: string): string {
  return text.replace(/\s/gu, '').toLowerCase()
}

/** Normalise a date cell to `YYYY-MM-DD`, or return the raw text. */
export function normaliseDate(text: string): string {
  const trimmed = text.trim()
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(trimmed)
  if (iso !== null) {
    const [, year = '', month = '', day = ''] = iso
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/u.exec(trimmed)
  if (compact !== null) {
    const [, year = '', month = '', day = ''] = compact
    return `${year}-${month}-${day}`
  }
  return trimmed
}

/**
 * Load and validate the rule pack.
 *
 * @param yaml - the pack file's text.
 * @returns the pack with its profile and rules.
 * @throws LedgerError when the schema or a rule is malformed.
 */
export function loadPack(yaml: string): LedgerPack {
  const parsed = parseYaml(yaml) as Record<string, unknown> | undefined
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    throw new LedgerError('规则库不是映射')
  }
  const profileRaw = (parsed.profile ?? {}) as Record<string, unknown>
  const companyRaw = (profileRaw.company ?? {}) as Record<string, unknown>
  const sequenceRaw = (profileRaw.sequence ?? {}) as Record<string, unknown>
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

  const profile: LedgerProfile = {
    companyName: String(companyRaw.name ?? ''),
    companyTaxId: String(companyRaw.taxId ?? ''),
    aliases: Array.isArray(companyRaw.aliases) ? companyRaw.aliases.map(String) : [],
    entities: Array.isArray(companyRaw.entities)
      ? companyRaw.entities.map((raw) => {
          const entry = raw as Record<string, unknown>
          return { name: String(entry.name ?? ''), taxId: String(entry.taxId ?? '') }
        })
      : [],
    companyStartDate: String(profileRaw.companyStartDate ?? ''),
    period: String(profileRaw.period ?? ''),
    amountTolerance: num(profileRaw.amountTolerance, 0.01),
    roundingTolerance: num(profileRaw.roundingTolerance, 0.02),
    lineTolerance: num(profileRaw.lineTolerance, 0.02),
    internalSubmitDays: num(profileRaw.internalSubmitDays, 90),
    largeAmountThreshold: num(profileRaw.largeAmountThreshold, 1_000_000),
    sameSellerDailyThreshold: num(profileRaw.sameSellerDailyThreshold, 10),
    sequence: {
      minRun: num(sequenceRaw.minRun, 3),
      maxGap: num(sequenceRaw.maxGap, 2),
      windowDays: num(sequenceRaw.windowDays, 31),
      highVolumeSellers: Array.isArray(sequenceRaw.highVolumeSellers)
        ? sequenceRaw.highVolumeSellers.map(String)
        : [],
    },
  }

  const rawRules = Array.isArray(parsed.rules) ? parsed.rules : []
  if (rawRules.length === 0) throw new LedgerError('规则库没有任何规则')
  const rules: LedgerRule[] = rawRules.map((raw) => {
    const entry = raw as Record<string, unknown>
    const id = String(entry.id ?? '')
    if (id === '') throw new LedgerError('有规则缺少 id')
    const check = ((entry.params as Record<string, unknown> | undefined)?.check ?? {}) as Record<string, unknown>
    if (check.kind === undefined) throw new LedgerError(`规则 ${id} 缺少 params.check.kind`)
    const basis = (entry.basis ?? {}) as Record<string, unknown>
    const severity = String(entry.severity ?? 'warn')
    if (severity !== 'error' && severity !== 'warn' && severity !== 'info') {
      throw new LedgerError(`规则 ${id} 的 severity「${severity}」不受支持`)
    }
    return {
      id,
      title: String(entry.title ?? ''),
      severity,
      basis: {
        document: String(basis.document ?? ''),
        number: String(basis.number ?? ''),
        clause: String(basis.clause ?? ''),
        excerpt: String(basis.excerpt ?? ''),
        kind: String(basis.kind ?? ''),
        source: String(basis.source ?? ''),
      },
      check: check as LedgerRule['check'],
      note: String(entry.note ?? ''),
    }
  })
  return { version: String(parsed.version ?? ''), profile, rules }
}

/** The check kinds this version implements. */
export const IMPLEMENTED = new Set([
  'invoiceKey',
  'duplicateAcross',
  'lineTotals',
  'lineMath',
  'formTotals',
  'rateEquation',
  'ageReminder',
  'numberRange',
  'sequenceRun',
  'groupCount',
  'taxStatus',
  'moneyEquation',
  'partyMatch',
  'partyCompare',
  'dateWindow',
  'placeholderScan',
  'uniqueInvoice',
])

/** Build a finding, filling `basis` from the rule. */
function findingOf(
  rule: LedgerRule,
  row: number,
  invoiceNumber: string,
  message: string,
  actual: string,
  expected: string,
  suggestion: string,
): LedgerFinding {
  return {
    ruleId: rule.id,
    severities: rule.severity,
    row,
    invoiceNumber,
    message,
    actual,
    expected,
    suggestion,
    basis: `《${rule.basis.document}》${rule.basis.number} ${rule.basis.clause}：${rule.basis.excerpt}`,
  }
}

/** True when the cell is empty or a placeholder left in a template. */
function isPlaceholder(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  return /^(示例|样例|XX+|xxx+|待填|TODO|TBD|请填写|N\/A|\*+|—+|-+)$/iu.test(trimmed)
    || trimmed.includes('示例')
}

/**
 * Run every implemented rule over the ledger.
 *
 * @param pack - the loaded rule pack.
 * @param table - the ledger table.
 * @param today - the reference date for age checks (`YYYY-MM-DD`).
 * @returns findings plus the rules that were not executed.
 */
/** Resolve a `${profile.x}` template used by the pack's check parameters. */
function resolve(value: unknown, profile: LedgerProfile): unknown {
  if (typeof value !== 'string') return value
  const match = /^\$\{profile\.([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)\}$/u.exec(value)
  if (match === null) return value
  const path = (match[1] ?? '').split('.')
  const table: Record<string, unknown> = {
    period: profile.period,
    internalSubmitDays: profile.internalSubmitDays,
    amountTolerance: profile.amountTolerance,
    roundingTolerance: profile.roundingTolerance,
    lineTolerance: profile.lineTolerance,
    companyStartDate: profile.companyStartDate,
    // No history-file entry point exists in this version; keep the template
    // resolved to an empty string so callers can tell "not configured" from
    // an unresolved `${...}` literal.
    historyFile: '',
  }
  if (path.length === 1) return table[path[0] ?? ''] ?? value
  if (path[0] === 'company' && path.length === 2) {
    const company: Record<string, unknown> = {
      name: profile.companyName,
      taxId: profile.companyTaxId,
      aliases: profile.aliases,
      entities: profile.entities,
    }
    const key = path[1] ?? ''
    if (Object.hasOwn(company, key)) return company[key]
  }
  return value
}

/** True when the remark matches one of the downgrade phrases. */
function remarkDowngrades(remark: string, phrases: string[]): boolean {
  return phrases.some((phrase) => phrase !== '' && remark.includes(phrase))
}

/**
 * Run every implemented rule over the ledger.
 *
 * The parameter names read here are the ones the shipped pack actually uses
 * (`field`, `notFuture`, `fields`, `target`, `patterns`), not guessed ones: a
 * mismatch would leave the rule installed but never firing, which reads as a
 * clean ledger.
 *
 * @param pack - the loaded rule pack.
 * @param table - the ledger table.
 * @param today - the reference date for age and future checks.
 * @returns findings plus the rules that were not executed.
 */
export function check(pack: LedgerPack, table: TableJson, today: string): LedgerResult {
  const rows = table.rows
  const findings: LedgerFinding[] = []
  const unsupported: UnsupportedRule[] = []
  const skipped: SkippedRule[] = []
  const notes: string[] = []
  const profile = pack.profile
  const cell = (row: Record<string, string> | undefined, key: string): string => (row?.[key] ?? '').trim()
  const numberKey = (row: Record<string, string> | undefined): string =>
    `${cell(row, 'invoiceCode')}|${cell(row, 'invoiceNumber')}`

  for (const rule of pack.rules) {
    if (!IMPLEMENTED.has(rule.check.kind)) unsupported.push({ id: rule.id, title: rule.title, kind: rule.check.kind })
  }

  const push = (
    rule: LedgerRule,
    row: number,
    invoiceNumber: string,
    message: string,
    actual: string,
    expected: string,
    suggestion: string,
    severityOverride?: 'error' | 'warn' | 'info',
  ): void => {
    findings.push({
      ruleId: rule.id,
      severities: severityOverride ?? rule.severity,
      row,
      invoiceNumber,
      message,
      actual,
      expected,
      suggestion,
      basis: `《${rule.basis.document}》${rule.basis.number} ${rule.basis.clause}：${rule.basis.excerpt}`,
    })
  }

  for (const rule of pack.rules) {
    if (!IMPLEMENTED.has(rule.check.kind)) continue

    switch (rule.check.kind) {
      case 'invoiceKey': {
        const numberField = String(rule.check.numberField ?? 'invoiceNumber')
        const dateField = String(rule.check.dateField ?? 'issueDate')
        const docTypeField = String(rule.check.docTypeField ?? 'docType')
        const patterns = (rule.check.patterns ?? {}) as Record<string, string>
        rows.forEach((row, index) => {
          const number = cell(row, numberField)
          if (number === '') {
            push(rule, index + 1, '', '发票号码为空', '(空)', '按票种为 8 位或 20 位', '补齐号码；空号通常是表尾合计行')
            return
          }
          const docType = cell(row, docTypeField)
          const pattern = patterns[docType]
          if (pattern !== undefined && !new RegExp(pattern, 'u').test(number)) {
            push(rule, index + 1, number, `票种「${docType}」的号码格式不符`, number, `符合 ${pattern}`, '确认票种或号码是否录错')
          } else if (pattern === undefined && !/^\d{8,20}$/u.test(number)) {
            push(rule, index + 1, number, '号码既不是 8 位也不是 20 位数字', number, '8–20 位数字', '确认票种；票种不明时只校验位数')
          }
          if (rule.check.crossCheckYearPrefix === true && number.length === 20) {
            const issue = normaliseDate(cell(row, dateField))
            const year = /^(\d{4})-/u.exec(issue)?.[1]
            if (year !== undefined && number.slice(0, 2) !== year.slice(2)) {
              push(rule, index + 1, number, '号码的年度前缀与开票日期不符', number.slice(0, 2), year.slice(2), '核对开票日期或号码')
            }
          }
        })
        continue
      }

      case 'moneyEquation': {
        const fields = Array.isArray(rule.check.fields) ? rule.check.fields.map(String) : []
        const target = String(rule.check.target ?? 'total')
        const tolerance = minor(String(rule.check.roundingTolerance ?? rule.check.tolerance ?? 0.01)) ?? 2n
        if (fields.length !== 2) {
          unsupported.push({ id: rule.id, title: rule.title, kind: `${rule.check.kind}（只支持两数相加）` })
          continue
        }
        const downgrades = Array.isArray(rule.check.downgradeWhenRemarkContains)
          ? rule.check.downgradeWhenRemarkContains.map(String)
          : []
        rows.forEach((row, index) => {
          const left = minor(cell(row, fields[0] ?? ''))
          const right = minor(cell(row, fields[1] ?? ''))
          const sum = minor(cell(row, target))
          if (left === undefined || right === undefined || sum === undefined) {
            if (cell(row, target) !== '' || cell(row, fields[0] ?? '') !== '') {
              push(rule, index + 1, cell(row, 'invoiceNumber'), '金额列不是可比较的数字', `${cell(row, fields[0] ?? '')} / ${cell(row, fields[1] ?? '')} / ${cell(row, target)}`, '数字', '清洗金额列（去掉单位与文字）')
            }
            return
          }
          const delta = sum - (left + right)
          const magnitude = delta < 0n ? -delta : delta
          if (magnitude > tolerance) {
            // A difference that a known special-case remark explains is downgraded,
            // not hidden: the reader still sees it and can decide.
            const downgraded = remarkDowngrades(cell(row, 'remark'), downgrades)
            push(
              rule,
              index + 1,
              cell(row, 'invoiceNumber'),
              `${target} 与 ${fields.join(' + ')} 相差 ${money(delta)}`,
              money(sum),
              money(left + right),
              downgraded
                ? '备注命中差额征税/通行费/成品油等特殊情形，本条降级为提示，请人工确认'
                : '核对票面；差额征税、通行费、成品油等情形可能不适用该等式',
              downgraded ? 'warn' : undefined,
            )
          }
        })
        continue
      }

      case 'uniqueInvoice':
      case 'duplicateAcross': {
        const against = Array.isArray(rule.check.against) ? rule.check.against.map(String) : []
        const formNoField = String(rule.check.formNoField ?? 'formNo')
        const seen = new Map<string, number[]>()
        rows.forEach((row, index) => {
          const key = numberKey(row)
          if (key === '|') return
          const bucket = seen.get(key)
          if (bucket === undefined) seen.set(key, [index + 1])
          else bucket.push(index + 1)
        })
        for (const [key, rowList] of seen) {
          if (rowList.length < 2) continue
          const forms = new Set(rowList.map((rowNumber) => cell(rows[rowNumber - 1], formNoField)))
          const sameForm = forms.size === 1 && [...forms][0] !== ''
          const number = key.split('|')[1] ?? ''
          if (rule.check.kind === 'uniqueInvoice') {
            const conflictFields = Array.isArray(rule.check.conflictFields) ? rule.check.conflictFields.map(String) : []
            const differing = conflictFields.filter((field) => new Set(rowList.map((rowNumber) => cell(rows[rowNumber - 1], field))).size > 1)
            push(
              rule,
              rowList[1] ?? 0,
              number,
              differing.length > 0
                ? `同一张票在批量内出现 ${rowList.length} 次，且 ${differing.join('、')} 不一致（第 ${rowList.join('、')} 行）`
                : `同一张票在批量内重复登记 ${rowList.length} 次（第 ${rowList.join('、')} 行）`,
              `第 ${rowList.join('、')} 行`,
              '每张票只出现一次',
              '核对是否重复登记',
            )
            continue
          }
          // duplicateAcross: within one ledger, a repeat is only suspicious when it
          // spans reimbursement forms; the same form listing a ticket twice is a
          // bookkeeping duplicate, which uniqueInvoice already covers.
          if (against.includes('forms') && !sameForm) {
            push(
              rule,
              rowList[1] ?? 0,
              number,
              `同一张票出现在 ${forms.size} 个报销单（第 ${rowList.join('、')} 行）`,
              [...forms].filter((form) => form !== '').join(' / ') || '(无单号)',
              '每张票只报销一次',
              '核对是否重复报销；历史台账未提供时本条只看本批次',
            )
          }
        }
        if (against.includes('history') && rule.check.requireHistory !== true) {
          notes.push(`规则 ${rule.id} 的「历史台账」比对未执行：本版本没有持久化或历史文件入口，只比对了本批次`)
        }
        continue
      }

      case 'sequenceRun': {
        const fields = Array.isArray(rule.check.groupBy) ? rule.check.groupBy.map(String) : ['sellerTaxId', 'buyerTaxId', 'issueYear']
        const numberField = String(rule.check.numberField ?? 'invoiceNumber')
        const minRun = Number(rule.check.minRun ?? profile.sequence.minRun)
        const maxGap = BigInt(Math.max(1, Number(rule.check.maxGap ?? profile.sequence.maxGap)))
        const highVolume = Array.isArray(rule.check.highVolumeSellers)
          ? rule.check.highVolumeSellers.map(String)
          : profile.sequence.highVolumeSellers

        const groupOf = (row: Record<string, string>): string | undefined => {
          const values: string[] = []
          for (const field of fields) {
            let value = cell(row, field)
            if (value === '' && field === 'issueYear') value = cell(row, 'issueDate').slice(0, 4)
            if (value === '') return undefined
            values.push(value)
          }
          return values.join('\u0000')
        }

        const groups = new Map<string, { index: number; number: bigint; date: string }[]>()
        rows.forEach((row, index) => {
          const key = groupOf(row)
          if (key === undefined) return
          const seller = cell(row, 'sellerName')
          if (highVolume.some((name) => name !== '' && seller.includes(name))) return
          const raw = cell(row, numberField).replace(/\D/gu, '')
          if (raw === '') return
          let number: bigint
          try { number = BigInt(raw) } catch { return }
          const bucket = groups.get(key)
          const entry = { index, number, date: cell(row, 'issueDate') }
          if (bucket === undefined) groups.set(key, [entry])
          else bucket.push(entry)
        })

        let measured = 0
        for (const [key, entries] of groups) {
          measured += 1
          entries.sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0))
          let run: typeof entries = []
          const flush = (): void => {
            if (run.length < minRun) return
            const first = run[0]!
            const last = run[run.length - 1]!
            push(rule, first.index + 1, cell(rows[first.index], numberField), `同一组出现 ${run.length} 张连号发票（${cell(rows[first.index], numberField)}–${cell(rows[last.index], numberField)}）`, String(run.length), `< ${minRun} 张连号`, '连号可能是商超/加油站/公用事业正常开票，也可能是拆分；仅提示抽查，不写“虚开”', 'info')
          }
          for (const entry of entries) {
            const previous = run[run.length - 1]
            if (previous !== undefined && entry.number - previous.number > maxGap) {
              flush()
              run = []
            }
            run.push(entry)
          }
          flush()
          void key
        }
        if (measured === 0) skipped.push({ id: rule.id, title: rule.title, kind: rule.check.kind, reason: `没有完整的 ${fields.join('/')} 分组字段或发票号，本条未执行` })
        continue
      }

      case 'ageReminder': {
        const field = String(rule.check.field ?? 'issueDate')
        const warnAfter = Number(rule.check.warnAfterYears ?? 5)
        const noteAfter = Number(rule.check.noteAfterYears ?? warnAfter)
        const message = String(rule.check.message ?? `发票开具已超过 ${warnAfter} 年`)
        const todayMs = Date.parse(`${today}T00:00:00Z`)
        const yearMs = 365.25 * 24 * 60 * 60 * 1000
        let measured = 0
        rows.forEach((row, index) => {
          const raw = cell(row, field)
          if (raw === '') return
          const date = normaliseDate(raw)
          const ms = Date.parse(`${date}T00:00:00Z`)
          if (!Number.isFinite(ms)) return
          measured += 1
          const years = (todayMs - ms) / yearMs
          if (years >= warnAfter) {
            const severity = years >= Math.max(warnAfter, noteAfter) ? 'info' : 'warn'
            push(rule, index + 1, cell(row, 'invoiceNumber'), `${message}（开票日期 ${date}，距今约 ${years.toFixed(1)} 年）`, date, `开票未超过 ${warnAfter} 年`, '核对是否仍可在线查验；归档期限与查验期限是两件事', severity)
          }
        })
        if (measured === 0) skipped.push({ id: rule.id, title: rule.title, kind: rule.check.kind, reason: `没有可解析的「${field}」日期，本条未执行` })
        continue
      }

      case 'numberRange': {
        const field = String(rule.check.field ?? 'total')
        const zeroSeverity = String(rule.check.zeroSeverity ?? 'info') as 'error' | 'warn' | 'info'
        const negativeSeverity = String(rule.check.negativeWithoutRedSeverity ?? 'error') as 'error' | 'warn' | 'info'
        const largeSeverity = String(rule.check.largeSeverity ?? 'info') as 'error' | 'warn' | 'info'
        const largeThreshold = rule.check.largeThreshold === undefined || String(rule.check.largeThreshold).includes('${')
          ? profile.largeAmountThreshold
          : Number(rule.check.largeThreshold)
        const rateRange = (rule.check.rateRange ?? {}) as Record<string, unknown>
        const rateMin = Number(rateRange.min ?? 0)
        const rateMax = Number(rateRange.max ?? 0.13)
        const rateSeverity = String(rateRange.severity ?? 'warn') as 'error' | 'warn' | 'info'
        let measured = 0
        rows.forEach((row, index) => {
          const raw = cell(row, field)
          const total = minor(raw)
          if (total === undefined) return
          measured += 1
          if (total === 0n) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), `${field} 为 0`, '0.00', '金额应大于 0', '核对是否为空票或录入错误', zeroSeverity)
          } else if (total < 0n) {
            const red = cell(row, 'redLetter') !== '' || cell(row, 'isRed') === 'true' || cell(row, 'invoiceType').includes('红')
            if (!red) push(rule, index + 1, cell(row, 'invoiceNumber'), `${field} 为负数 ${money(total)}，但没有红字标记`, money(total), '负数金额应来自红字发票', '核对红字发票关联；红票优先走 INV-008', negativeSeverity)
          } else if (largeThreshold > 0 && Number(total) > largeThreshold * 100) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), `${field} ${money(total)} 超过大额提示阈值 ${largeThreshold}`, money(total), `不超过 ${largeThreshold}`, '大额仅提示，核对合同与审批', largeSeverity)
          }
          const rate = parseRate(cell(row, 'taxRate'))
          if (rate !== undefined && (rate < rateMin || rate > rateMax)) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), `税率 ${(rate * 100).toFixed(2)}% 超出合理范围 ${rateMin * 100}%–${rateMax * 100}%`, `${(rate * 100).toFixed(2)}%`, `${rateMin * 100}%–${rateMax * 100}%`, '核对税率是否录错；特殊税率请人工确认', rateSeverity)
          }
        })
        if (measured === 0) skipped.push({ id: rule.id, title: rule.title, kind: rule.check.kind, reason: `没有可解析的「${field}」金额，本条未执行` })
        continue
      }

      case 'groupCount': {
        const fields = Array.isArray(rule.check.groupBy) ? rule.check.groupBy.map(String) : ['sellerTaxId', 'buyerTaxId', 'issueDate']
        const threshold = Number(rule.check.threshold ?? profile.sameSellerDailyThreshold)
        const severity = String(rule.check.severity ?? rule.severity) as 'error' | 'warn' | 'info'
        const groups = new Map<string, number[]>()
        rows.forEach((row, index) => {
          const values = fields.map((field) => cell(row, field))
          if (values.some((value) => value === '')) return
          const key = values.join('\u0000')
          const bucket = groups.get(key)
          if (bucket === undefined) groups.set(key, [index])
          else bucket.push(index)
        })
        let measured = 0
        for (const [key, indexes] of groups) {
          measured += 1
          if (indexes.length < threshold) continue
          const values = key.split('\u0000')
          push(rule, (indexes[0] ?? 0) + 1, '', `同一组（${fields.map((field, i) => `${field}=${values[i]}`).join('、')}）共 ${indexes.length} 张，达到阈值 ${threshold}`, String(indexes.length), `< ${threshold}`, '集中开票可能是月底报销/批量采购/拆分；仅提示，不阻断', severity)
        }
        if (measured === 0) skipped.push({ id: rule.id, title: rule.title, kind: rule.check.kind, reason: `没有完整的 ${fields.join('/')} 分组字段，本条未执行` })
        continue
      }

      case 'formTotals': {
        const formNoField = String(rule.check.formNoField ?? 'formNo')
        const formAmountField = String(rule.check.formAmountField ?? 'formAmount')
        const invoiceTotalField = String(rule.check.invoiceTotalField ?? 'total')
        const nonInvoiceField = String(rule.check.nonInvoiceAmountField ?? 'nonInvoiceAmount')
        const tolerance = minor(String(rule.check.tolerance ?? 0.01)) ?? 1n
        const allowPartial = rule.check.allowPartial !== false
        const partialSeverity = String(rule.check.partialSeverity ?? 'info') as 'error' | 'warn' | 'info'
        const overSeverity = String(rule.check.overSeverity ?? 'error') as 'error' | 'warn' | 'info'

        const groups = new Map<string, number[]>()
        rows.forEach((row, index) => {
          const formNo = cell(row, formNoField)
          if (formNo === '') return
          const bucket = groups.get(formNo)
          if (bucket === undefined) groups.set(formNo, [index])
          else bucket.push(index)
        })
        if (groups.size === 0) {
          skipped.push({ id: rule.id, title: rule.title, kind: rule.check.kind, reason: `台账没有「${formNoField}」列或该列为空，无法按报销单汇总` })
          continue
        }
        for (const [formNo, indexes] of groups) {
          const formAmounts = [...new Set(indexes.map((index) => cell(rows[index], formAmountField)).filter((text) => text !== ''))]
          if (formAmounts.length === 0) {
            skipped.push({ id: rule.id, title: rule.title, kind: rule.check.kind, reason: `报销单 ${formNo} 没有 ${formAmountField}，本条未执行` })
            continue
          }
          if (formAmounts.length > 1) {
            push(rule, (indexes[0] ?? 0) + 1, '', `报销单 ${formNo} 的 ${formAmountField} 在多行之间不一致`, formAmounts.join(' / '), '同一报销单只应有一个申报金额', '核对报销单表头')
            continue
          }
          const formAmount = minor(formAmounts[0])
          if (formAmount === undefined) continue
          let invoiceTotal = 0n
          let nonInvoice = 0n
          let usable = true
          for (const index of indexes) {
            const total = minor(cell(rows[index], invoiceTotalField))
            if (total !== undefined) invoiceTotal += total
            const extra = minor(cell(rows[index], nonInvoiceField))
            if (extra !== undefined) nonInvoice = extra
            if (cell(rows[index], invoiceTotalField) !== '' && total === undefined) usable = false
          }
          if (!usable) continue
          const expected = invoiceTotal + nonInvoice
          const delta = formAmount - expected
          if (delta > tolerance) {
            push(rule, (indexes[0] ?? 0) + 1, '', `报销单 ${formNo} 申报 ${money(formAmount)}，比发票合计 ${money(expected)} 多 ${money(delta)}`, money(formAmount), money(expected), '核对报销单是否含无票补贴；含无票金额请用 nonInvoiceAmount 拆分', overSeverity)
          } else if (delta < -tolerance) {
            push(rule, (indexes[0] ?? 0) + 1, '', `报销单 ${formNo} 申报 ${money(formAmount)}，比发票合计 ${money(expected)} 少 ${money(-delta)}`, money(formAmount), money(expected), '核对是否部分报销；部分报销需显式标记', allowPartial ? partialSeverity : overSeverity)
          }
        }
        continue
      }

      case 'rateEquation': {
        const amountField = String(rule.check.amountField ?? 'amount')
        const rateField = String(rule.check.rateField ?? 'taxRate')
        const taxField = String(rule.check.taxField ?? 'tax')
        const toleranceAbs = minor(String(rule.check.toleranceAbs ?? 0.01)) ?? 1n
        const tolerancePct = Number(rule.check.tolerancePct ?? 0.0005)
        const skipRates = Array.isArray(rule.check.skipRateValues) ? rule.check.skipRateValues.map((value) => rateLabel(String(value))) : []
        let measured = 0
        rows.forEach((row, index) => {
          const rawRate = cell(row, rateField)
          if (rawRate === '' || skipRates.includes(rateLabel(rawRate))) return
          const rate = parseRate(rawRate)
          if (rate === undefined) return
          const amount = minor(cell(row, amountField))
          const tax = minor(cell(row, taxField))
          if (amount === undefined || tax === undefined) return
          measured += 1
          const expected = BigInt(Math.round(Number(amount) * rate))
          const proportional = BigInt(Math.round(Math.abs(Number(amount)) * tolerancePct))
          const tolerance = toleranceAbs > proportional ? toleranceAbs : proportional
          const delta = tax - expected
          const magnitude = delta < 0n ? -delta : delta
          if (magnitude > tolerance) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), `税率 ${rawRate} × 金额 ${money(amount)} = 税额 ${money(expected)}，与票面税额 ${money(tax)} 相差 ${money(delta)}`, money(tax), money(expected), '核对税率、金额与税额；多税率、折扣、简易计税、差额征税可能不适用')
          }
        })
        if (measured === 0) skipped.push({ id: rule.id, title: rule.title, kind: rule.check.kind, reason: '没有可解析的税率/金额/税额行，本条未执行' })
        continue
      }

      case 'taxStatus': {
        const rateField = String(rule.check.rateField ?? 'taxRate')
        const taxField = String(rule.check.taxField ?? 'tax')
        const exemptValues = Array.isArray(rule.check.exemptValues) ? rule.check.exemptValues.map((value) => rateLabel(String(value))) : []
        const tolerance = minor(String(rule.check.tolerance ?? 0.01)) ?? 1n
        let measured = 0
        rows.forEach((row, index) => {
          const rawRate = cell(row, rateField)
          if (rawRate === '') return
          const tax = minor(cell(row, taxField))
          if (tax === undefined) return
          measured += 1
          const exempt = exemptValues.includes(rateLabel(rawRate))
          if (exempt && (tax > tolerance || tax < -tolerance)) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), `税率/状态为「${rawRate}」但税额为 ${money(tax)}`, money(tax), '免税/不征税/零税率时税额应为 0', '核对税率与税额；出口/即征即退/差额征税等例外请人工确认')
          } else if (!exempt && tax === 0n) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), `税率为「${rawRate}」但税额为 0`, '0.00', '非免税/零税率时税额不应为 0', '核对税率与税额；免税/不征税请用对应状态值')
          }
        })
        if (measured === 0) skipped.push({ id: rule.id, title: rule.title, kind: rule.check.kind, reason: '没有可解析的税率/税额行，本条未执行' })
        continue
      }

      case 'lineTotals': {
        const groupBy = String(rule.check.groupBy ?? 'invoiceKey')
        const sumFields = Array.isArray(rule.check.sumFields) ? rule.check.sumFields.map(String) : []
        const targetFields = Array.isArray(rule.check.targetFields) ? rule.check.targetFields.map(String) : []
        const tolerance = minor(String(rule.check.tolerance ?? 0.02)) ?? 2n
        if (groupBy !== 'invoiceKey' || sumFields.length === 0 || sumFields.length !== targetFields.length) {
          unsupported.push({ id: rule.id, title: rule.title, kind: `${rule.check.kind}（参数不完整）` })
          continue
        }
        // An absent detail column is not a clean bill of health. Report the skip
        // under its own heading so "no finding" never reads as "checked".
        const missingFields = sumFields.filter((field) => !rows.some((row) => cell(row, field) !== ''))
        if (missingFields.length > 0) {
          skipped.push({
            id: rule.id,
            title: rule.title,
            kind: rule.check.kind,
            reason: `台账没有明细列 ${missingFields.join('、')}（当前是票面行台账），本规则未执行`,
          })
          continue
        }
        const lineGroups = new Map<string, number[]>()
        rows.forEach((row, index) => {
          const key = numberKey(row)
          if (key === '|') return
          const bucket = lineGroups.get(key)
          if (bucket === undefined) lineGroups.set(key, [index])
          else bucket.push(index)
        })
        let measuredGroups = 0
        for (const [key, indexes] of lineGroups) {
          if (indexes.length < 2) continue
          const invoiceNumber = key.split('|')[1] ?? ''
          const header: bigint[] = []
          let usable = true
          for (const field of targetFields) {
            const distinct = [...new Set(indexes.map((index) => cell(rows[index], field)).filter((text) => text !== ''))]
            if (distinct.length === 0) {
              usable = false
              break
            }
            if (distinct.length > 1) {
              // The header amount differs between the detail rows of one invoice.
              // Which one is the real 票面 is not knowable from the ledger, so this
              // is reported rather than resolved by picking a row.
              push(
                rule,
                (indexes[0] ?? 0) + 1,
                invoiceNumber,
                `同一张票的 ${field} 在明细行之间不一致`,
                distinct.join(' / '),
                `每行都应是同一个票面 ${field}`,
                '统一票面金额，或把这张票拆成两张登记',
              )
              usable = false
              break
            }
            const value = minor(distinct[0])
            if (value === undefined) {
              usable = false
              break
            }
            header.push(value)
          }
          if (!usable) continue
          measuredGroups += 1
          for (let position = 0; position < sumFields.length; position += 1) {
            const field = sumFields[position] ?? ''
            let sum = 0n
            let complete = true
            for (const index of indexes) {
              const value = minor(cell(rows[index], field))
              if (value === undefined) {
                complete = false
                break
              }
              sum += value
            }
            if (!complete) continue
            const target = header[position] ?? 0n
            const delta = sum - target
            const magnitude = delta < 0n ? -delta : delta
            if (magnitude > tolerance) {
              push(
                rule,
                (indexes[0] ?? 0) + 1,
                invoiceNumber,
                `明细 ${field} 合计 ${money(sum)} 与票面 ${targetFields[position]} ${money(target)} 相差 ${money(delta)}`,
                money(sum),
                money(target),
                '核对明细行；折扣行、多税率、汇总开票、差额征税会不满足本恒等式',
              )
            }
          }
        }
        if (measuredGroups === 0) {
          skipped.push({
            id: rule.id,
            title: rule.title,
            kind: rule.check.kind,
            reason: '没有同一张票的多行明细（每张票只有一行），明细合计恒等式无可核对',
          })
        }
        continue
      }

      case 'lineMath': {
        const leftFields = Array.isArray(rule.check.leftFields) ? rule.check.leftFields.map(String) : []
        const targetField = String(rule.check.targetField ?? 'lineAmount')
        if (leftFields.length !== 2) {
          unsupported.push({ id: rule.id, title: rule.title, kind: `${rule.check.kind}（需要两个乘数）` })
          continue
        }
        const [quantityField = '', unitPriceField = ''] = leftFields
        const unitField = String(rule.check.unitField ?? 'unit')
        const taxField = String(rule.check.priceTaxInclusiveField ?? 'priceTaxInclusive')
        const skipUnits = Array.isArray(rule.check.skipUnits) ? rule.check.skipUnits.map(String) : []
        const skipIfPriceTaxInclusive = rule.check.skipIfPriceTaxInclusive === true
        const toleranceAbs = minor(String(rule.check.toleranceAbs ?? 0.01)) ?? 1n
        const tolerancePct = scaled(String(rule.check.tolerancePct ?? 0.001), 6) ?? 1000n
        let measuredLines = 0
        rows.forEach((row, index) => {
          const quantity = scaled(cell(row, quantityField), 4)
          const unitPrice = scaled(cell(row, unitPriceField), 4)
          const amount = minor(cell(row, targetField))
          if (quantity === undefined || unitPrice === undefined || amount === undefined) return
          // A unit sold by the batch or by the job has no meaningful 单价×数量.
          if (skipUnits.includes(cell(row, unitField))) return
          // Only skip when the ledger actually states the price is tax-inclusive;
          // `lineAmount` is a 不含税 column elsewhere in this pack, so silence means
          // "not stated", and treating silence as "含税" would disable the rule.
          if (skipIfPriceTaxInclusive && /^(true|TRUE|是|含税|1)$/u.test(cell(row, taxField))) return
          measuredLines += 1
          const expected = rescale(quantity * unitPrice, 8, 2)
          const delta = amount - expected
          const magnitude = delta < 0n ? -delta : delta
          const proportional = ((amount < 0n ? -amount : amount) * tolerancePct) / 1_000_000n
          const tolerance = toleranceAbs > proportional ? toleranceAbs : proportional
          if (magnitude > tolerance) {
            push(
              rule,
              index + 1,
              cell(row, 'invoiceNumber'),
              `数量 ${cell(row, quantityField)} × 单价 ${cell(row, unitPriceField)} = ${money(expected)}，与 ${targetField} ${money(amount)} 相差 ${money(delta)}`,
              money(amount),
              money(expected),
              '核对数量、单价与行金额；含税单价、折扣行、多单位会造成差异',
            )
          }
        })
        if (measuredLines === 0) {
          skipped.push({
            id: rule.id,
            title: rule.title,
            kind: rule.check.kind,
            reason: `没有可用的 ${quantityField}/${unitPriceField}/${targetField} 数值或全部被单位规则跳过`,
          })
        }
        continue
      }

      case 'dateWindow': {
        const field = String(rule.check.field ?? 'issueDate')
        const period = String(resolve(rule.check.period, profile) ?? '')
        const notFuture = rule.check.notFuture === true
        const maxDays = Number(resolve(rule.check.internalSubmitDays, profile))
        const minDateRaw = rule.check.minDate === undefined ? '' : String(resolve(rule.check.minDate, profile) ?? '')
        const minDate = normaliseDate(minDateRaw)
        const hasMinDate = /^\d{4}-\d{2}-\d{2}$/u.test(minDate)
        const contractField = rule.check.contractDateField === undefined ? '' : String(rule.check.contractDateField)
        rows.forEach((row, index) => {
          const raw = cell(row, field)
          if (raw === '') return
          const date = normaliseDate(raw)
          if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), '开票日期无法解析', raw, 'YYYY-MM-DD', '统一日期格式', String(rule.check.futureSeverity ?? 'error') as 'error')
            return
          }
          if (notFuture && date > today) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), '开票日期晚于今天', date, `≤ ${today}`, '确认日期是否录错', String(rule.check.futureSeverity ?? 'error') as 'error')
          }
          if (hasMinDate && date < minDate) {
            push(
              rule,
              index + 1,
              cell(row, 'invoiceNumber'),
              `开票日期早于允许的最早日期（${minDate}）`,
              date,
              `≥ ${minDate}`,
              '确认日期是否录错；公司成立前的票据需要人工判断',
              String(rule.check.beforeMinDateSeverity ?? 'warn') as 'warn',
            )
          }
          if (period !== '' && /^\d{4}-\d{2}$/u.test(period) && !date.startsWith(period)) {
            push(
              rule,
              index + 1,
              cell(row, 'invoiceNumber'),
              `开票日期不在本期（${period}）`,
              date.slice(0, 7),
              period,
              '跨期票可能属于上期报销；确认归属期间',
              String(rule.check.crossYearSeverity ?? 'warn') as 'warn',
            )
          }
          if (contractField !== '') {
            const contract = normaliseDate(cell(row, contractField))
            if (/^\d{4}-\d{2}-\d{2}$/u.test(contract) && date < contract) {
              push(rule, index + 1, cell(row, 'invoiceNumber'), '开票日期早于合同日期', date, `≥ ${contract}`, '确认合同与发票的先后关系是否正常', String(rule.check.beforeContractSeverity ?? 'warn') as 'warn')
            }
          }
          if (Number.isFinite(maxDays) && maxDays > 0) {
            const days = Math.floor((Date.parse(today) - Date.parse(date)) / 86_400_000)
            if (Number.isFinite(days) && days > maxDays) {
              push(rule, index + 1, cell(row, 'invoiceNumber'), `开票日期距今 ${days} 天，超过内部报销时限`, `${days} 天`, `≤ ${maxDays} 天`, '确认是否仍可报销；这是内部口径，不是税法期限', 'info')
            }
          }
        })
        continue
      }

      case 'placeholderScan': {
        const fields = Array.isArray(rule.check.fields) ? rule.check.fields.map(String) : []
        const patterns = Array.isArray(rule.check.patterns) ? rule.check.patterns.map(String) : []
        const compiled = patterns.map((pattern) => {
          try {
            return new RegExp(pattern, 'u')
          } catch {
            notes.push(`规则 ${rule.id} 的正则 ${pattern} 无法编译，已跳过该条模式`)
            return undefined
          }
        }).filter((regex): regex is RegExp => regex !== undefined)
        rows.forEach((row, index) => {
          for (const column of fields) {
            const value = cell(row, column)
            if (value === '') continue
            const hit = compiled.find((regex) => regex.test(value))
            if (hit !== undefined) {
              push(rule, index + 1, cell(row, 'invoiceNumber'), `「${column}」仍是模板占位内容`, value, '真实数据', '替换示例值后再核对')
            }
          }
        })
        continue
      }

      case 'partyMatch': {
        const partyFields = Object.keys(rule.check).filter((key) => key.endsWith('NameField') || key.endsWith('TaxIdField'))
        // A rule with a buyer field (or an explicit master) is about *our*
        // company; a rule that only names seller fields is about the
        // counterparty and must not be compared with the company master data.
        const buyerSide =
          rule.check.buyerNameField !== undefined ||
          rule.check.buyerTaxIdField !== undefined ||
          rule.check.masterName !== undefined ||
          rule.check.masterTaxId !== undefined
        const nameField = String(rule.check.buyerNameField ?? rule.check.sellerNameField ?? '')
        const taxField = String(rule.check.buyerTaxIdField ?? rule.check.sellerTaxIdField ?? '')
        const requireName = rule.check.requireName === true
        const masterName = String(resolve(rule.check.masterName, profile) ?? profile.companyName)
        const masterTax = String(resolve(rule.check.masterTaxId, profile) ?? profile.companyTaxId)
        const aliases = Array.isArray(rule.check.aliases) ? rule.check.aliases.map(String) : profile.aliases
        const entities = Array.isArray(rule.check.entities)
          ? rule.check.entities.map((raw) => {
              const entry = raw as Record<string, unknown>
              return { name: String(entry.name ?? ''), taxId: String(entry.taxId ?? '') }
            })
          : profile.entities
        const allowedNames = new Set([masterName, ...aliases, ...entities.map((entity) => entity.name)])
        const allowedTax = new Set([masterTax, ...entities.map((entity) => entity.taxId)].filter((id) => id !== ''))
        const allowedDocTypes = new Set(
          (Array.isArray(rule.check.personalTitleAllowedDocTypes) ? rule.check.personalTitleAllowedDocTypes : []).map(String),
        )
        if (nameField === '') {
          unsupported.push({ id: rule.id, title: rule.title, kind: `${rule.check.kind}（未指定名称字段：${partyFields.join(',')}）` })
          continue
        }
        rows.forEach((row, index) => {
          const name = cell(row, nameField)
          const taxId = cell(row, taxField)
          const docType = cell(row, 'docType')
          if (!buyerSide) {
            // The seller is the other party in this ledger, so it is never
            // "this company": comparing its name or tax id with our own master
            // data flags every real invoice. Check that the field is filled
            // when the pack asks for it; format and checksum validation stay
            // with the rule pack (INV-010 declares them).
            if (requireName && name === '' && table.columns.includes(nameField)) {
              push(rule, index + 1, cell(row, 'invoiceNumber'), `${nameField} 为空`, '(空)', '销方名称（非空）', '补齐销方名称后再核对')
            }
            return
          }
          if (allowedDocTypes.has(docType)) return
          if (name !== '' && !allowedNames.has(name)) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), `${nameField} 不是本公司`, name, masterName, '核对抬头；个人抬头的火车票/机票等按票种白名单放行')
            return
          }
          if (taxField !== '' && taxId !== '' && allowedTax.size > 0 && !allowedTax.has(taxId)) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), `${taxField} 不是本公司或已登记的分支机构`, taxId, [...allowedTax].join(' / '), '确认这张票能否在本公司报销')
          }
        })
        continue
      }

      case 'partyCompare': {
        const leftField = String(rule.check.leftField ?? '')
        const rightField = String(rule.check.rightField ?? '')
        const relation = String(rule.check.relation ?? 'equal')
        if (leftField === '' || rightField === '') {
          unsupported.push({ id: rule.id, title: rule.title, kind: `${rule.check.kind}（缺少字段）` })
          continue
        }
        rows.forEach((row, index) => {
          const left = cell(row, leftField)
          const right = cell(row, rightField)
          if (left === '' || right === '') return
          const same = relation === 'equal' ? left === right : relation === 'differ' ? left !== right : true
          if (!same) {
            push(rule, index + 1, cell(row, 'invoiceNumber'), `${leftField} 与 ${rightField} ${relation === 'equal' ? '应当相同' : '应当不同'}`, left, right, '核对两个字段的来源')
          }
        })
        continue
      }

      default:
        unsupported.push({ id: rule.id, title: rule.title, kind: rule.check.kind })
    }
  }

  // Counted from the pack, never hard-coded: a rule added to the YAML must not be
  // able to sit outside the executed/skipped/unsupported partition.
  const summary = {
    rows: rows.length,
    errors: findings.filter((item) => item.severities === 'error').length,
    warnings: findings.filter((item) => item.severities === 'warn').length,
    infos: findings.filter((item) => item.severities === 'info').length,
    total: pack.rules.length,
    executed: pack.rules.length - unsupported.length - skipped.length,
    skipped: skipped.length,
    unsupported: unsupported.length,
  }
  return { findings, unsupported, skipped, summary, warnings: [...new Set(notes)] }
}
