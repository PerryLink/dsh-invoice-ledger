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
  period: string
  amountTolerance: number
  roundingTolerance: number
  lineTolerance: number
  internalSubmitDays: number
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

/** The whole result. */
export interface LedgerResult {
  findings: LedgerFinding[]
  unsupported: UnsupportedRule[]
  summary: { rows: number; errors: number; warnings: number; infos: number }
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
    period: String(profileRaw.period ?? ''),
    amountTolerance: num(profileRaw.amountTolerance, 0.01),
    roundingTolerance: num(profileRaw.roundingTolerance, 0.02),
    lineTolerance: num(profileRaw.lineTolerance, 0.02),
    internalSubmitDays: num(profileRaw.internalSubmitDays, 90),
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
  'formTotals',
  'lineTotals',
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
  const match = /^\$\{profile\.([A-Za-z]+)\}$/u.exec(value)
  if (match === null) return value
  const key = match[1] ?? ''
  const table: Record<string, unknown> = {
    period: profile.period,
    internalSubmitDays: profile.internalSubmitDays,
    amountTolerance: profile.amountTolerance,
    roundingTolerance: profile.roundingTolerance,
    lineTolerance: profile.lineTolerance,
    companyStartDate: '',
    historyFile: '',
  }
  return table[key] ?? value
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

      case 'dateWindow': {
        const field = String(rule.check.field ?? 'issueDate')
        const period = String(resolve(rule.check.period, profile) ?? '')
        const notFuture = rule.check.notFuture === true
        const maxDays = Number(resolve(rule.check.internalSubmitDays, profile))
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
        const nameField = String(rule.check.buyerNameField ?? rule.check.sellerNameField ?? '')
        const taxField = String(rule.check.buyerTaxIdField ?? rule.check.sellerTaxIdField ?? '')
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

  const summary = {
    rows: rows.length,
    errors: findings.filter((item) => item.severities === 'error').length,
    warnings: findings.filter((item) => item.severities === 'warn').length,
    infos: findings.filter((item) => item.severities === 'info').length,
  }
  return { findings, unsupported, summary, warnings: [...new Set(notes)] }
}
