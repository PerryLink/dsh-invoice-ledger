/**
 * Markdown report and anomaly workbook for an invoice ledger.
 *
 * The "not executed" section comes first. A ledger with four findings and
 * eleven unexecuted rules reads as "four problems" unless the report says
 * otherwise, and eleven of twenty-six checks is not a clean bill of health.
 */

import { writeWorkbook, type Cell, type Sheet } from './xlsx-write.ts'
import type { LedgerResult } from './engine.ts'

/** Column order of the anomaly sheet. */
export const ANOMALY_COLUMNS = [
  '序号',
  '严重程度',
  '规则',
  '行号',
  '发票号码',
  '问题',
  '实际值',
  '期望值',
  '建议处理',
  '依据',
  '处理状态',
] as const

/**
 * Render the ledger check as markdown.
 *
 * @param result - check outcome.
 * @param source - ledger file path.
 * @param packVersion - rule pack version.
 * @returns markdown text.
 */
export function renderMarkdown(result: LedgerResult, source: string, packVersion: string): string {
  const lines: string[] = []
  lines.push('# 发票台账核对')
  lines.push('')
  lines.push(`- 检查对象：${source}`)
  lines.push(`- 规则库版本：${packVersion}`)
  lines.push(
    `- 结果统计：错误 ${result.summary.errors} · 提示 ${result.summary.warnings} · 参考 ${result.summary.infos} · 台账 ${result.summary.rows} 行`,
  )
  lines.push(`- 已执行规则：${26 - result.unsupported.length} 条 · 未执行 ${result.unsupported.length} 条`)
  lines.push('')

  if (result.unsupported.length > 0) {
    lines.push('## 未执行的规则（不代表通过）')
    lines.push('')
    lines.push('以下规则本版本没有实现对应的检查类型，**没有运行**：')
    lines.push('')
    for (const rule of result.unsupported) {
      lines.push(`- \`${rule.id}\` ${rule.title}（检查类型 \`${rule.kind}\`）`)
    }
    lines.push('')
  }

  if (result.findings.length === 0) {
    lines.push('## 未发现异常')
    lines.push('')
    lines.push('已执行的规则都没有报出问题。未执行的规则见上。')
  } else {
    lines.push('## 异常清单')
    lines.push('')
    const order: Record<string, number> = { error: 0, warn: 1, info: 2 }
    const sorted = [...result.findings].sort((left, right) => (order[left.severities] ?? 9) - (order[right.severities] ?? 9))
    for (const item of sorted) {
      const label = item.severities === 'error' ? '错误' : item.severities === 'warn' ? '提示' : '参考'
      lines.push(`- **[${label}] ${item.ruleId}** — 第 ${item.row} 行${item.invoiceNumber === '' ? '' : `（${item.invoiceNumber}）`}：${item.message}`)
      lines.push(`  - 实际：${item.actual}｜期望：${item.expected}`)
      lines.push(`  - 建议：${item.suggestion}`)
      lines.push(`  - 依据：${item.basis}`)
    }
  }

  if (result.warnings.length > 0) {
    lines.push('')
    lines.push('## 提示')
    lines.push('')
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }

  lines.push('')
  lines.push('## 边界')
  lines.push('')
  lines.push('本报告只核对台账与票面自身的一致性与完整性，不判定虚开，不判定业务真实性，不替代税务机关查验，也不替代财务复核。')
  lines.push('税率-品名、连号、集中开票属于风险提示，不是定性结论。')
  lines.push('未执行的规则不等于通过：它们没有运行。')
  lines.push('')
  return lines.join('\n')
}

/** Build the anomaly workbook. */
export function buildWorkbook(result: LedgerResult): Buffer {
  const rows: Cell[][] = result.findings.map((item, index) => [
    index + 1,
    item.severities === 'error' ? '错误' : item.severities === 'warn' ? '提示' : '参考',
    item.ruleId,
    item.row,
    item.invoiceNumber,
    item.message,
    item.actual,
    item.expected,
    item.suggestion,
    item.basis,
    '',
  ])
  const anomaly: Sheet = {
    name: '异常清单',
    header: [...ANOMALY_COLUMNS],
    rows,
    widths: [6, 10, 10, 6, 24, 44, 22, 22, 32, 52, 10],
    freezeAfterColumn: 4,
  }
  const summary: Sheet = {
    name: '汇总',
    header: ['项', '值'],
    rows: [
      ['台账行数', result.summary.rows],
      ['错误', result.summary.errors],
      ['提示', result.summary.warnings],
      ['参考', result.summary.infos],
      ['已执行规则', 26 - result.unsupported.length],
      ['未执行规则', result.unsupported.length],
    ],
    widths: [24, 40],
  }
  const unsupported: Sheet = {
    name: '未执行规则',
    header: ['规则', '标题', '检查类型'],
    rows: result.unsupported.map((rule) => [rule.id, rule.title, rule.kind]),
    widths: [12, 44, 18],
  }
  return writeWorkbook([summary, anomaly, unsupported])
}
