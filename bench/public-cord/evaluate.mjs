#!/usr/bin/env node
/**
 * End-to-end CORD benchmark for the real dsh-invoice-ledger plugin.
 *
 * The plugin is imported from ../../lib/index.mjs and its registered
 * `invoice_ledger` tool is called with each generated ledger file. No rule
 * logic is reimplemented here: the expectations are labels, the predictions
 * are the findings the plugin itself returns.
 *
 * Usage:
 *   node bench/public-cord/evaluate.mjs --limit 20
 *   node bench/public-cord/evaluate.mjs --limit 20 --no-images
 *   node bench/public-cord/evaluate.mjs --limit 20 --no-write --json
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../../lib/index.mjs'
import { buildBenchmark, FIELD_MAPPING, ABSENT_FIELDS } from './adapter.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const DEFAULT_TODAY = '2026-11-10'
const SCHEMA_VERSION = 1

/**
 * Why each rule is or is not grounded in CORD.
 *
 * `provided: 'image'` means the field comes from the public JPEG, not
 * gt_parse. `scorable` rules are the only ones in the P/R table.
 */
const COVERAGE = {
  'INV-001': {
    provided: false,
    reason: 'CORD gt_parse has no invoiceCode/invoiceNumber/docType. The shipped check still emits 发票号码为空 for every row; that is an absence signal, not a CORD defect.',
  },
  'INV-002': {
    provided: false,
    reason: 'CORD gt_parse has no issueDate.',
  },
  'INV-003': {
    provided: true,
    scorable: true,
    source: 'CORD sub_total.subtotal_price, sub_total.tax_price, total.total_price',
    note: 'The arithmetic identity is tested on CORD money values; discounts/service lines are excluded by receipt selection.',
  },
  'INV-004': {
    provided: false,
    reason: 'CORD gt_parse has no taxRate.',
  },
  'INV-005': {
    provided: false,
    reason: 'CORD has no invoiceCode/invoiceNumber. A duplicated row is an unscorable probe, not an INV-005 score.',
  },
  'INV-006': {
    provided: false,
    reason: 'CORD has no invoiceCode/invoiceNumber, formNo or history file.',
  },
  'INV-007': {
    provided: 'image',
    scorable: true,
    source: 'image_file -> sourceFile; SHA-256 of the JPEG',
    note: 'The shipped fileLink check also verifies sourceFile existence, so this rule fires on the missing-original variant alongside INV-024. Labels follow the shipped behavior.',
  },
  'INV-008': {
    provided: false,
    reason: 'CORD gt_parse has no isRed, originalInvoiceNumber or red-letter marker.',
  },
  'INV-009': {
    provided: false,
    reason: 'CORD gt_parse has no buyerName/buyerTaxId.',
  },
  'INV-010': {
    provided: false,
    reason: 'CORD gt_parse has no sellerName/sellerTaxId.',
  },
  'INV-011': {
    provided: false,
    reason: 'CORD gt_parse has no itemName/taxRate pair for this check.',
  },
  'INV-012': {
    provided: false,
    reason: 'CORD gt_parse has no taxRate/免税 status.',
  },
  'INV-013': {
    provided: false,
    reason: 'CORD menu lines are not mapped to the ledger detail-row shape; there is no lineTax.',
  },
  'INV-014': {
    provided: false,
    reason: 'CORD menu quantity/price are line-level and are not mapped into the invoice-row quantity/unitPrice/lineAmount shape.',
  },
  'INV-015': {
    provided: false,
    reason: 'CORD has no sellerTaxId/buyerTaxId/issueYear or invoice number.',
  },
  'INV-016': {
    provided: false,
    reason: 'CORD has no sellerTaxId/buyerTaxId/issueDate.',
  },
  'INV-017': {
    provided: false,
    reason: 'CORD has no issueDate, period or contract date.',
  },
  'INV-018': {
    provided: false,
    reason: 'CORD has no issueDate.',
  },
  'INV-019': {
    provided: false,
    reason: 'CORD has no formNo/formAmount.',
  },
  'INV-020': {
    provided: false,
    reason: 'CORD has no invoice key or formNo.',
  },
  'INV-021': {
    provided: false,
    reason: 'CORD has no buyerName/docType.',
  },
  'INV-022': {
    provided: false,
    reason: 'CORD has no buyerTaxId/sellerTaxId.',
  },
  'INV-023': {
    provided: true,
    scorable: true,
    source: 'CORD total.total_price',
    note: 'Only the total branch is measured; CORD has no taxRate. The large-amount branch is not tested because the profile threshold is CNY and CORD amounts are IDR.',
  },
  'INV-024': {
    provided: 'image',
    scorable: true,
    source: 'image_file -> sourceFile; SHA-256 of the JPEG',
    note: 'The missing-original variant is synthetic; the clean variants use the real public JPEG.',
  },
  'INV-025': {
    provided: false,
    reason: 'CORD has no buyerName/sellerName/invoiceNumber/remark.',
  },
  'INV-026': {
    provided: 'meta',
    reason: 'Coverage meta-rule. It runs and stays silent when every rule is accounted for; it has no CORD defect to detect.',
  },
}

const SCORABLE_SOURCES = {
  'INV-003': 'CORD money fields',
  'INV-007': 'image-derived sourceFile',
  'INV-023': 'CORD total',
  'INV-024': 'image-derived sourceFile',
}

function ruleNumber(id) {
  return Number.parseInt(id.slice(4), 10)
}

function round(value) {
  return value === null ? null : Number(value.toFixed(6))
}

async function loadRuleTitles() {
  const text = await readFile(join(REPO_ROOT, 'rules/invoice-ledger.yaml'), 'utf8')
  const titles = new Map()
  for (const match of text.matchAll(/^  - id: (INV-\d+)\r?\n    title: (.+)$/gmu)) {
    titles.set(match[1], match[2].trim())
  }
  if (titles.size !== 26) throw new Error(`expected 26 rules in rules/invoice-ledger.yaml, found ${titles.size}`)
  for (const id of titles.keys()) {
    if (COVERAGE[id] === undefined) throw new Error(`no benchmark coverage entry for ${id}`)
  }
  return titles
}

async function loadPluginVersion() {
  return JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')).version
}

async function loadFixtureInfo() {
  const lock = JSON.parse(await readFile(join(HERE, 'data.lock.json'), 'utf8'))
  let fetchReport
  try {
    fetchReport = JSON.parse(await readFile(join(HERE, 'data/fetch-report.json'), 'utf8'))
  } catch {
    fetchReport = undefined
  }
  return {
    dataset: lock.dataset,
    split: lock.split,
    license: lock.license,
    attribution: lock.attribution,
    source: lock.source,
    mirror: lock.mirror,
    paper: lock.paper,
    files: Object.entries(lock.files).map(([name, info]) => ({ name, bytes: info.bytes, sha256: info.sha256 })),
    images: fetchReport?.images ?? null,
    extraction: fetchReport?.extraction ?? null,
  }
}

function registerTool() {
  const registered = []
  const ctx = { tools: { register: (tool) => { registered.push(tool); return () => {} } } }
  plugin.apply(ctx, plugin.Config({}))
  const tool = registered.find((candidate) => candidate.name === plugin.TOOL_NAME)
  if (tool === undefined) throw new Error(`plugin did not register ${plugin.TOOL_NAME}`)
  return tool
}

function actualScored(parsed, scoredRuleIds, sanitize) {
  return parsed.findings
    .filter((finding) => scoredRuleIds.has(finding.ruleId))
    .map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severities,
      row: finding.row,
      message: sanitize(finding.message),
      actual: sanitize(finding.actual),
      expected: sanitize(finding.expected),
    }))
    .sort((left, right) => ruleNumber(left.ruleId) - ruleNumber(right.ruleId) || left.row - right.row)
}

function emptyExecution() {
  return { finding_cases: 0, skipped_cases: 0, unsupported_cases: 0, manual_cases: 0, finding_instances: 0 }
}

function perRuleExecution(parsed, execution, titles) {
  for (const title of titles.keys()) {
    if (execution[title] === undefined) execution[title] = emptyExecution()
  }
  const seen = new Set()
  for (const finding of parsed.findings) {
    if (execution[finding.ruleId] === undefined) execution[finding.ruleId] = emptyExecution()
    execution[finding.ruleId].finding_instances += 1
    seen.add(finding.ruleId)
  }
  for (const id of seen) execution[id].finding_cases += 1
  for (const skipped of parsed.skipped) {
    if (execution[skipped.id] === undefined) execution[skipped.id] = emptyExecution()
    execution[skipped.id].skipped_cases += 1
  }
  for (const unsupported of parsed.unsupported) {
    if (execution[unsupported.id] === undefined) execution[unsupported.id] = emptyExecution()
    execution[unsupported.id].unsupported_cases += 1
  }
  for (const manual of parsed.manual) {
    if (execution[manual.id] === undefined) execution[manual.id] = emptyExecution()
    execution[manual.id].manual_cases += 1
  }
}

function formatRatio(value) {
  return value === null ? 'n/a' : value.toFixed(3)
}

function renderMarkdown(summary) {
  const lines = []
  lines.push('# CORD-v2 public-data benchmark — results')
  lines.push('')
  lines.push('Generated by `node bench/public-cord/evaluate.mjs`; do not edit by hand.')
  lines.push('')
  lines.push(`- Plugin: \`${summary.plugin.name}\` ${summary.plugin.version}, tool \`${summary.plugin.tool}\`, rule pack ${summary.plugin.packVersion}`)
  lines.push(`- Dataset: ${summary.dataset.name} (${summary.dataset.split} split), ${summary.dataset.license}, ${summary.dataset.selectedReceipts} of ${summary.dataset.records} receipts selected`)
  lines.push(`- Pinned reference date: \`${summary.today}\` (CORD provides no dates, so this does not affect findings)`)
  lines.push(`- Cases: ${summary.cases.total} (${summary.cases.scored} scored, ${summary.cases.probes} probe)`)
  lines.push('')
  lines.push('## How to reproduce')
  lines.push('')
  lines.push('```sh')
  for (const command of summary.commands) lines.push(command)
  lines.push('```')
  lines.push('')
  lines.push('The first command obtains the two prepared CORD artifacts (cache, `--from` seed, or `--download`) and verifies both SHA-256 hashes. `evaluate.mjs` builds every ledger in a fresh OS temp directory and calls the registered plugin tool with it; no generated ledger is committed.')
  lines.push('')
  lines.push('## Per-rule precision / recall')
  lines.push('')
  lines.push('Case-level: a rule is a true positive when the case is labelled with that rule and the plugin returned a finding for it; a false positive when it returned a finding on a case without that label; a false negative when the label has no finding. Clean cases are negatives. Probe cases are excluded.')
  lines.push('')
  lines.push('| Rule | Title | Field source | Positives | TP | FP | FN | TN | Precision | Recall |')
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const rule of summary.scored_rules) {
    lines.push(`| ${rule.id} | ${rule.title} | ${rule.field_source} | ${rule.positives} | ${rule.tp} | ${rule.fp} | ${rule.fn} | ${rule.tn} | ${formatRatio(rule.precision)} | ${formatRatio(rule.recall)} |`)
  }
  lines.push('')
  lines.push('## Excluded rules (required field not provided by CORD)')
  lines.push('')
  lines.push('| Rule | Reason |')
  lines.push('| --- | --- |')
  for (const rule of summary.excluded_rules) {
    lines.push(`| ${rule.id} | ${rule.reason} |`)
  }
  lines.push('')
  lines.push('## Duplicate-key probe')
  lines.push('')
  for (const probe of summary.probes) {
    lines.push(`- **${probe.ruleId}** — ${probe.status}; ${probe.cases} duplicate-row cases, ${probe.detectedCases} detected. ${probe.reason}`)
  }
  lines.push('')
  lines.push('## Raw plugin output')
  lines.push('')
  lines.push(`Across ${summary.raw.cases} cases and ${summary.raw.rows} ledger rows the plugin returned ${summary.raw.findings} findings: ${summary.raw.errors} error, ${summary.raw.warnings} warn, ${summary.raw.infos} info. ${summary.raw.skipped} rule-per-case executions were reported as skipped; ${summary.raw.executed} as executed.`)
  lines.push(`Clean cases: ${summary.raw.clean.scored_findings} scored findings and ${summary.raw.clean.unscored_findings} unscored findings (the INV-001 absence signal across their rows).`)
  lines.push('')
  lines.push('| Rule | Findings | In P/R? |')
  lines.push('| --- | ---: | --- |')
  for (const entry of summary.raw.by_rule) {
    lines.push(`| ${entry.id} | ${entry.findings} | ${entry.scored ? 'yes' : 'no'} |`)
  }
  lines.push('')
  lines.push('`INV-001` warnings are `发票号码为空` on every row: CORD supplies no invoice number, so this is a field-absence signal, not a labelled CORD defect. It is excluded from P/R and reported above.')
  lines.push('')
  lines.push('## Plugin coverage observation')
  lines.push('')
  lines.push(`The plugin's \`executed\` counter counts a rule whose loop ran, even when every required field is blank. These rules were counted as executed but had no data to measure (no skipped entry): ${summary.coverage_observation.silent_rules.join(', ') || 'none'}. This is a coverage-accounting observation about the shipped plugin, not a benchmark failure.`)
  lines.push('')
  lines.push('## Limitations')
  lines.push('')
  for (const limitation of summary.limitations) lines.push(`- ${limitation}`)
  lines.push('')
  lines.push('Full machine-readable output: `bench/public-cord/summary.json`.')
  lines.push('')
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = {
    dataDir: process.env.CORD_DATA_DIR || join(HERE, 'data'),
    limit: 20,
    today: DEFAULT_TODAY,
    includeImages: true,
    write: true,
    json: false,
    outDir: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--data': args.dataDir = argv[++i]; break
      case '--limit': args.limit = Number(argv[++i]); break
      case '--today': args.today = argv[++i]; break
      case '--no-images': args.includeImages = false; break
      case '--no-write': args.write = false; break
      case '--json': args.json = true; break
      case '--out': args.outDir = argv[++i]; break
      case '--help': case '-h':
        console.log('usage: node bench/public-cord/evaluate.mjs [--data DIR] [--limit N] [--today YYYY-MM-DD] [--no-images] [--out DIR] [--no-write] [--json]')
        process.exit(0)
      default: throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer')
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.today)) throw new Error('--today must be YYYY-MM-DD')
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const titles = await loadRuleTitles()
  const pluginVersion = await loadPluginVersion()
  const fixture = await loadFixtureInfo()

  const ledgerRoot = args.outDir !== undefined
    ? resolve(args.outDir)
    : await mkdtemp(join(tmpdir(), 'dsh-cord-ledger-eval-'))
  const anomaliesDir = join(ledgerRoot, 'anomalies')
  await mkdir(anomaliesDir, { recursive: true })

  const manifest = await buildBenchmark({
    dataDir: args.dataDir,
    outDir: ledgerRoot,
    limit: args.limit,
    includeImages: args.includeImages,
  })

  const imageRulesAvailable = manifest.columns.includes('sourceFile')
  const scoredRuleIds = new Set(
    Object.entries(COVERAGE)
      .filter(([, coverage]) => coverage.scorable === true && (coverage.provided !== 'image' || imageRulesAvailable))
      .map(([id]) => id),
  )

  const coverage = Object.fromEntries(Object.entries(COVERAGE).map(([id, entry]) => {
    if (entry.provided === 'image' && !imageRulesAvailable) {
      return [id, {
        ...entry,
        provided: false,
        scorable: false,
        reason: `${entry.reason} The image files were not extracted or --no-images was used, so this rule is not scored.`,
      }]
    }
    return [id, entry]
  }))

  for (const id of Object.keys(coverage)) {
    if (!titles.has(id)) throw new Error(`coverage names unknown rule ${id}`)
  }

  const tool = registerTool()
  const imagePrefix = join(resolve(args.dataDir), 'images')
  const sanitize = (text) => String(text ?? '')
    .replaceAll(imagePrefix, '<cord-images>')
    .replaceAll(ledgerRoot, '<temp>')
  let packVersion = ''
  const cases = []
  const rawByRule = new Map()
  const execution = Object.fromEntries([...titles.keys()].map((id) => [id, emptyExecution()]))
  const raw = {
    cases: 0, rows: 0, findings: 0, errors: 0, warnings: 0, infos: 0,
    executed: 0, skipped: 0, unsupported: 0, manual: 0,
  }

  for (const entry of manifest.cases) {
    const outFile = join(anomaliesDir, `${entry.caseId}.xlsx`)
    const result = await tool.execute(
      { file: entry.ledgerFile, today: args.today, outFile },
      { signal: new AbortController().signal },
    )
    const parsed = JSON.parse(result.resultJson)
    if (packVersion === '') packVersion = String(result.packVersion ?? '')
    const actual = actualScored(parsed, scoredRuleIds, sanitize)
    perRuleExecution(parsed, execution, titles)

    raw.cases += 1
    raw.rows += result.summary.rows
    raw.findings += parsed.findings.length
    raw.errors += result.summary.errors
    raw.warnings += result.summary.warnings
    raw.infos += result.summary.infos
    raw.executed += result.summary.executed
    raw.skipped += result.summary.skipped
    raw.unsupported += result.summary.unsupported
    raw.manual += result.summary.manual

    const counts = {}
    for (const finding of parsed.findings) counts[finding.ruleId] = (counts[finding.ruleId] ?? 0) + 1
    for (const [id, count] of Object.entries(counts)) rawByRule.set(id, (rawByRule.get(id) ?? 0) + count)

    const scoredExpected = entry.expected.filter((label) => scoredRuleIds.has(label.ruleId)).map((label) => label.ruleId)
    const probeFindings = entry.probe === null
      ? []
      : parsed.findings.filter((finding) => finding.ruleId === entry.probe.ruleId).map((finding) => ({
          ruleId: finding.ruleId,
          severity: finding.severities,
          row: finding.row,
          message: sanitize(finding.message),
        }))

    cases.push({
      caseId: entry.caseId,
      receipt: entry.receipt,
      receiptIndex: entry.receiptIndex,
      variant: entry.variant,
      rows: entry.rows,
      expected: scoredExpected,
      actual,
      raw_findings_by_rule: counts,
      probe: entry.probe === null ? null : {
        ruleId: entry.probe.ruleId,
        status: entry.probe.status,
        detected: probeFindings.length > 0,
        findings: probeFindings,
      },
      plugin: {
        executed: result.summary.executed,
        skipped: result.summary.skipped,
        unsupported: result.summary.unsupported,
        skippedRules: parsed.skipped.map((item) => item.id),
      },
    })
  }

  const scoredCases = cases.filter((entry) => entry.probe === null)
  const scoredRules = [...scoredRuleIds].sort((left, right) => ruleNumber(left) - ruleNumber(right)).map((id) => {
    const positives = scoredCases.filter((entry) => entry.expected.includes(id))
    const detected = scoredCases.filter((entry) => entry.actual.some((finding) => finding.ruleId === id))
    const tp = positives.filter((entry) => detected.includes(entry)).length
    const fn = positives.length - tp
    const fp = detected.filter((entry) => !positives.includes(entry)).length
    const tn = scoredCases.length - positives.length - fp
    const precision = tp + fp === 0 ? null : tp / (tp + fp)
    const recall = tp + fn === 0 ? null : tp / (tp + fn)
    return {
      id,
      title: titles.get(id),
      field_source: SCORABLE_SOURCES[id] ?? 'n/a',
      positives: positives.length,
      tp,
      fp,
      fn,
      tn,
      precision: round(precision),
      recall: round(recall),
      label_source: coverage[id].provided === true ? 'CORD' : coverage[id].provided,
      note: coverage[id].note ?? '',
    }
  })

  const excludedRules = [...titles.keys()]
    .filter((id) => !scoredRuleIds.has(id))
    .sort((left, right) => ruleNumber(left) - ruleNumber(right))
    .map((id) => ({
      id,
      title: titles.get(id),
      provided: coverage[id].provided,
      reason: coverage[id].reason,
    }))

  const probes = []
  for (const entry of cases.filter((item) => item.probe !== null)) {
    let probe = probes.find((item) => item.ruleId === entry.probe.ruleId)
    if (probe === undefined) {
      probe = {
        ruleId: entry.probe.ruleId,
        status: entry.probe.status,
        cases: 0,
        detectedCases: 0,
        reason: manifest.variants.find((variant) => variant.probe?.ruleId === entry.probe.ruleId)?.probe?.reason ?? '',
      }
      probes.push(probe)
    }
    probe.cases += 1
    if (entry.probe.detected) probe.detectedCases += 1
  }

  const executionList = [...titles.keys()]
    .sort((left, right) => ruleNumber(left) - ruleNumber(right))
    .map((id) => {
      const info = execution[id]
      const skipped = info.skipped_cases
      const unsupported = info.unsupported_cases
      const manual = info.manual_cases
      return {
        id,
        title: titles.get(id),
        provided: coverage[id].provided,
        finding_cases: info.finding_cases,
        finding_instances: info.finding_instances,
        skipped_cases: skipped,
        unsupported_cases: unsupported,
        manual_cases: manual,
        executed_cases: cases.length - skipped - unsupported - manual,
      }
    })

  const silentRules = executionList
    .filter((entry) => coverage[entry.id].provided === false && entry.skipped_cases === 0 && entry.unsupported_cases === 0)
    .map((entry) => entry.id)

  const rawTable = [...rawByRule.keys()]
    .sort((left, right) => ruleNumber(left) - ruleNumber(right))
    .map((id) => ({ id, title: titles.get(id) ?? '', findings: rawByRule.get(id) ?? 0, scored: scoredRuleIds.has(id) }))

  const cleanCases = cases.filter((entry) => entry.variant === 'clean')
  const cleanUnscored = cleanCases.reduce((sum, entry) => sum + Object.entries(entry.raw_findings_by_rule)
    .filter(([id]) => !scoredRuleIds.has(id))
    .reduce((inner, [, count]) => inner + count, 0), 0)
  raw.clean = {
    cases: cleanCases.length,
    scored_findings: cleanCases.reduce((sum, entry) => sum + entry.actual.length, 0),
    unscored_findings: cleanUnscored,
  }

  const perCaseStats = cases.map((entry) => entry.plugin)
  const pluginSummary = {
    rule_count: titles.size,
    total_rule_instances: cases.length * titles.size,
    executed_instances: raw.executed,
    skipped_instances: raw.skipped,
    unsupported_instances: raw.unsupported,
    manual_instances: raw.manual,
    executed_min: Math.min(...perCaseStats.map((item) => item.executed)),
    executed_max: Math.max(...perCaseStats.map((item) => item.executed)),
    skipped_min: Math.min(...perCaseStats.map((item) => item.skipped)),
    skipped_max: Math.max(...perCaseStats.map((item) => item.skipped)),
  }

  const limitations = [
    'CORD-v2 is an Indonesian receipt dataset, not a Chinese VAT invoice corpus. Its gt_parse has menu lines, sub_total and total only: no invoice code/number, issue date, buyer, seller, tax rate, form number, reimburser, remark, red-letter marker or line tax. Rules needing those fields are marked not provided and excluded from P/R; no values were invented.',
    `Only ${manifest.selectedReceipts.length} of ${args.limit === 20 ? 100 : 100} test receipts were selected, and they are the first receipts for which all three money fields exist and |amount + tax - total| <= 0.02 after 2-decimal rounding. Selection is about arithmetic consistency, not about invoice semantics.`,
    'CORD has three-decimal money in some receipts and IDR amounts while the shipped rule pack profile is CNY. The adapter normalises values to 2-decimal cents; the plugin does not use the currency field, so only numeric branches are exercised. The large-amount branch (1,000,000) is not tested because it would be meaningless for IDR amounts.',
    'sourceFile and sha256 are derived from the public JPEGs, not from gt_parse. The missing-original variant is synthetic. The shipped fileLink check verifies sourceFile existence in both INV-007 and INV-024, so both are labelled for that defect.',
    'INV-001 emits 发票号码为空 for every CORD row because CORD has no invoice number. Those findings are reported in the raw output but are not a labelled CORD defect and are excluded from P/R.',
    'The duplicate probe duplicates a clean row, but INV-005 cannot detect it: the plugin keys rows as "|" when invoiceCode/invoiceNumber are absent. The probe is reported as unscorable, not as a plugin pass or fail.',
    'CORD has no date at all, so future-date and age/period rules (INV-002, INV-017, INV-018) cannot be scored and no date was fabricated.',
    'The plugin reports some rules as executed even when their required fields are blank (see coverage observation). "executed" is not evidence that a rule was measured on this corpus.',
    'This benchmark measures the rule engine on gold annotations, not OCR/extraction quality. It also does not test the plugin workbook or markdown rendering beyond the tool call succeeding.',
  ]

  const summary = {
    schema_version: SCHEMA_VERSION,
    benchmark: 'public-cord',
    plugin: {
      name: plugin.name,
      version: pluginVersion,
      tool: plugin.TOOL_NAME,
      packVersion,
      entry: 'lib/index.mjs',
    },
    today: args.today,
    commands: [
      'node bench/public-cord/fetch.mjs --from /tmp/public-data/cord',
      `node bench/public-cord/evaluate.mjs --limit ${args.limit}${imageRulesAvailable ? '' : ' --no-images'}`,
    ],
    dataset: {
      name: 'CORD-v2',
      split: fixture.split,
      records: manifest.recordCount ?? args.limit,
      selectedReceipts: manifest.selectedReceipts.length,
      license: fixture.license,
      attribution: fixture.attribution,
      source: fixture.source,
      mirror: fixture.mirror,
      paper: fixture.paper,
      files: fixture.files,
      images: fixture.images,
      extraction: fixture.extraction,
      selectedReceiptIds: manifest.selectedReceipts.map((entry) => entry.image),
    },
    mapping: {
      fields: FIELD_MAPPING,
      absentFields: ABSENT_FIELDS,
    },
    cases: {
      total: cases.length,
      scored: scoredCases.length,
      probes: cases.filter((entry) => entry.probe !== null).length,
      byVariant: manifest.variants.map((variant) => ({
        variant: variant.name,
        cases: cases.filter((entry) => entry.variant === variant.name).length,
      })),
      details: cases,
    },
    rules: executionList,
    scored_rules: scoredRules,
    excluded_rules: excludedRules,
    probes,
    raw: {
      cases: raw.cases,
      rows: raw.rows,
      findings: raw.findings,
      errors: raw.errors,
      warnings: raw.warnings,
      infos: raw.infos,
      executed: raw.executed,
      skipped: raw.skipped,
      unsupported: raw.unsupported,
      manual: raw.manual,
      clean: raw.clean,
      by_rule: rawTable,
      plugin_summary: pluginSummary,
    },
    coverage_observation: {
      silent_rules: silentRules,
      note: 'Rules with provided=false, zero skipped entries and zero unsupported entries were counted as executed by the plugin even though no required field was present. INV-001 also has no data but still emits an absence finding.',
      absence_finding_rules: ['INV-001'],
    },
    limitations,
  }

  if (args.write) {
    await writeFile(join(HERE, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    await writeFile(join(HERE, 'RESULTS.md'), renderMarkdown(summary))
  }

  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      cases: {
        total: summary.cases.total,
        scored: summary.cases.scored,
        probes: summary.cases.probes,
        byVariant: summary.cases.byVariant,
      },
      scored_rules: summary.scored_rules,
      probes: summary.probes,
      raw: { findings: raw.findings, errors: raw.errors, warnings: raw.warnings, infos: raw.infos },
      silent_rules: silentRules,
      summary: args.write ? join(HERE, 'summary.json') : null,
      results: args.write ? join(HERE, 'RESULTS.md') : null,
    }, null, 2))
  } else {
    console.log(`${plugin.name}: ${summary.cases.total} cases (${summary.cases.scored} scored, ${summary.cases.probes} probe)`)
    for (const rule of summary.scored_rules) {
      console.log(`${rule.id}: TP=${rule.tp} FP=${rule.fp} FN=${rule.fn} precision=${formatRatio(rule.precision)} recall=${formatRatio(rule.recall)}`)
    }
    for (const probe of summary.probes) console.log(`${probe.ruleId} probe: ${probe.detectedCases}/${probe.cases} detected (${probe.status})`)
    console.log(`raw findings: ${raw.findings} (${raw.errors} error, ${raw.warnings} warn, ${raw.infos} info)`)
    if (args.write) console.log(`wrote ${join(HERE, 'summary.json')} and ${join(HERE, 'RESULTS.md')}`)
  }
}

main().catch((error) => {
  console.error(`[evaluate] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
