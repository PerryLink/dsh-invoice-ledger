#!/usr/bin/env node
/**
 * Turn CORD-v2 `gt_parse` annotations into the invoice-ledger CSV shape that
 * dsh-invoice-ledger actually reads.
 *
 * Only fields that exist in CORD are mapped:
 *
 *   ledger column   CORD source
 *   -------------   ------------------------------------------------------
 *   amount          ground_truth.gt_parse.sub_total.subtotal_price
 *   tax             ground_truth.gt_parse.sub_total.tax_price
 *   total           ground_truth.gt_parse.total.total_price
 *   sourceFile      extracted image_file (image-derived, optional)
 *   sha256          SHA-256 of that image (image-derived, optional)
 *   caseId          benchmark-assigned row id (NOT a CORD field; ignored by the plugin)
 *
 * CORD has no invoice code/number, issue date, buyer, seller, tax rate, form
 * number, reimburser, remark, line tax or red-letter marker. Those columns are
 * deliberately absent; they are not filled with placeholders. See README.md.
 *
 * Money is normalised to the plugin's 2-decimal model by converting to integer
 * cents and rounding half away from zero; some CORD values carry three decimal
 * places. The selected clean receipts are the first 20 test receipts for which
 * all three CORD totals exist and survive that rounding with
 * |amount + tax - total| <= 0.02.
 *
 * Usage:
 *   node bench/public-cord/adapter.mjs --limit 20
 *   node bench/public-cord/adapter.mjs --out /tmp/cord-ledgers --limit 20
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = join(HERE, 'data')
const JSONL = 'cord-test.jsonl.gz'
const IMAGES_ZIP = 'cord-test-images.zip'
export const LEDGER_COLUMNS = ['caseId', 'amount', 'tax', 'total', 'sourceFile', 'sha256']

/** Fields the ledger shape supports but CORD does not provide. */
export const ABSENT_FIELDS = [
  'invoiceCode',
  'invoiceNumber',
  'docType',
  'issueDate',
  'taxRate',
  'buyerName',
  'buyerTaxId',
  'sellerName',
  'sellerTaxId',
  'formNo',
  'formAmount',
  'reimburser',
  'remark',
  'lineAmount',
  'lineTax',
  'quantity',
  'unitPrice',
  'unit',
  'isRed',
  'originalInvoiceNumber',
  'sha256 (for duplicate-hash detection across invoice keys)',
]

/** CORD `gt_parse` -> ledger column mapping. */
export const FIELD_MAPPING = [
  { ledger: 'amount', source: 'ground_truth.gt_parse.sub_total.subtotal_price', transform: 'decimal -> integer cents -> 2dp half-up' },
  { ledger: 'tax', source: 'ground_truth.gt_parse.sub_total.tax_price', transform: 'decimal -> integer cents -> 2dp half-up' },
  { ledger: 'total', source: 'ground_truth.gt_parse.total.total_price', transform: 'decimal -> integer cents -> 2dp half-up' },
  { ledger: 'sourceFile', source: 'image_file, extracted from cord-test-images.zip', transform: 'absolute path to the public JPEG; image-derived, not gt_parse' },
  { ledger: 'sha256', source: 'bytes of that JPEG', transform: 'SHA-256 hex; image-derived, not gt_parse' },
  { ledger: 'caseId', source: 'benchmark case id', transform: 'synthetic row id, ignored by the plugin; not a CORD field' },
]

/** Every injected variant and its expected rule labels. */
export const VARIANTS = [
  {
    name: 'clean',
    count: 20,
    expected: [],
    description: 'CORD values unchanged; no injected defect.',
  },
  {
    name: 'total_mismatch',
    count: 20,
    expected: [{ ruleId: 'INV-003', reason: 'total increased by 100.00 while amount and tax are unchanged' }],
    description: 'total + 100.00; amount and tax unchanged.',
  },
  {
    name: 'missing_total',
    count: 20,
    expected: [{ ruleId: 'INV-003', reason: 'required total cell left blank' }],
    description: 'total column present but empty for the row.',
  },
  {
    name: 'zero_total',
    count: 20,
    expected: [
      { ruleId: 'INV-003', reason: 'total set to 0.00 while amount + tax is positive' },
      { ruleId: 'INV-023', reason: 'total is zero' },
    ],
    description: 'total set to 0.00; amount and tax unchanged.',
  },
  {
    name: 'negative_total',
    count: 5,
    expected: [
      { ruleId: 'INV-003', reason: 'total set to -100.00 while amount + tax is positive' },
      { ruleId: 'INV-023', reason: 'negative total without a red-letter marker' },
    ],
    description: 'total set to -100.00; no isRed column exists in CORD.',
  },
  {
    name: 'missing_tax',
    count: 5,
    expected: [{ ruleId: 'INV-003', reason: 'required tax cell left blank' }],
    description: 'tax column present but empty for the row.',
  },
  {
    name: 'missing_original',
    count: 5,
    requiresImages: true,
    expected: [
      { ruleId: 'INV-007', reason: 'sourceFile points at a file that does not exist (shipped fileLink check)' },
      { ruleId: 'INV-024', reason: 'sourceFile points at a file that does not exist (shipped fileLink check)' },
    ],
    description: 'sourceFile replaced with a non-existent path; sha256 still the real image hash.',
  },
  {
    name: 'duplicate_probe',
    count: 5,
    expected: [],
    probe: {
      ruleId: 'INV-005',
      status: 'unscorable',
      reason: 'CORD provides no invoiceCode/invoiceNumber; the plugin keys rows as "|" and uniqueInvoice silently skips them, so a duplicated row cannot be scored against INV-005.',
    },
    description: 'the clean row is duplicated verbatim in the same ledger file; unscorable probe, not part of P/R.',
  },
]

/** Parse a decimal string into integer cents, rounding half away from zero. */
export function parseCents(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim().replace(/[,，\s]/gu, '')
  if (text === '' || !/^[+-]?\d+(?:\.\d+)?$/u.test(text)) return undefined
  const negative = text.startsWith('-')
  const unsigned = negative ? text.slice(1) : text
  const [whole = '0', fraction = ''] = unsigned.split('.')
  const padded = `${fraction}000`.slice(0, 3)
  let cents = BigInt(whole === '' ? '0' : whole) * 100n + BigInt(padded.slice(0, 2))
  if (Number(padded[2] ?? '0') >= 5) cents += 1n
  return negative ? -cents : cents
}

/** Render integer cents as a 2-decimal string. */
export function formatCents(cents) {
  const negative = cents < 0n
  const digits = (negative ? -cents : cents).toString().padStart(3, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}

function abs(value) {
  return value < 0n ? -value : value
}

function quoteCsv(value) {
  const text = value ?? ''
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function toCsv(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const lines = [columns.map(quoteCsv).join(',')]
  for (const row of rows) lines.push(columns.map((column) => quoteCsv(row[column])).join(','))
  return `${lines.join('\n')}\n`
}

/** Read the gzipped JSONL fixture. */
export async function loadRecords(jsonlPath) {
  const compressed = await readFile(jsonlPath)
  const text = jsonlPath.endsWith('.gz') ? gunzipSync(compressed).toString('utf8') : compressed.toString('utf8')
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`line ${index + 1} of ${jsonlPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
}

function numbersOf(record) {
  const parse = record?.ground_truth?.gt_parse ?? {}
  const subTotal = parse?.sub_total ?? {}
  const total = parse?.total ?? {}
  const amount = parseCents(subTotal.subtotal_price)
  const tax = parseCents(subTotal.tax_price)
  const gross = parseCents(total.total_price)
  if (amount === undefined || tax === undefined || gross === undefined) return undefined
  if (abs(amount + tax - gross) > 2n) return undefined
  return { amount, tax, total: gross }
}

/**
 * Select the first `limit` receipts whose three CORD money fields exist and
 * satisfy amount + tax = total within 0.02 after 2-decimal rounding.
 */
export function selectReceipts(records, limit = 20) {
  const selected = []
  for (let index = 0; index < records.length && selected.length < limit; index += 1) {
    const numbers = numbersOf(records[index])
    if (numbers === undefined) continue
    const image = records[index]?.image_file
    if (typeof image !== 'string' || image === '') throw new Error(`selected record ${index} has no image_file`)
    selected.push({ index, record: records[index], numbers })
  }
  if (selected.length < limit) {
    throw new Error(`only ${selected.length} of the requested ${limit} receipts have complete, consistent amount/tax/total values`)
  }
  return selected
}

async function hashFile(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

function rowsForVariant(entry, variant, context) {
  const { amount, tax, total } = entry.numbers
  const base = {
    caseId: '',
    amount: formatCents(amount),
    tax: formatCents(tax),
    total: formatCents(total),
  }
  if (context.useImages) {
    base.sourceFile = join(context.imagesDir, entry.record.image_file)
    base.sha256 = context.hashes.get(entry.record.image_file)
  }

  switch (variant.name) {
    case 'clean':
      return [base]
    case 'total_mismatch':
      return [{ ...base, total: formatCents(total + 10_000n) }]
    case 'missing_total':
      return [{ ...base, total: '' }]
    case 'zero_total':
      return [{ ...base, total: '0.00' }]
    case 'negative_total':
      return [{ ...base, total: '-100.00' }]
    case 'missing_tax':
      return [{ ...base, tax: '' }]
    case 'missing_original':
      return [{ ...base, sourceFile: join(context.imagesDir, `missing-${entry.record.image_file}`) }]
    case 'duplicate_probe':
      return [base, { ...base }]
    default:
      throw new Error(`unknown variant ${variant.name}`)
  }
}

/**
 * Build one CSV ledger per case in `outDir`.
 *
 * @returns the case manifest plus the out directory.
 */
export async function buildBenchmark(options = {}) {
  const dataDir = resolve(options.dataDir ?? DEFAULT_DATA_DIR)
  const limit = options.limit ?? 20
  const includeImages = options.includeImages !== false
  const records = await loadRecords(join(dataDir, JSONL))
  const selected = selectReceipts(records, limit)
  const imagesDir = join(dataDir, 'images')
  const useImages = includeImages && existsSync(imagesDir) && selected.every((entry) => existsSync(join(imagesDir, entry.record.image_file)))

  const outDir = options.outDir !== undefined
    ? resolve(options.outDir)
    : await mkdtemp(join(tmpdir(), 'dsh-cord-ledgers-'))
  await mkdir(outDir, { recursive: true })

  const hashes = new Map()
  if (useImages) {
    for (const entry of selected) hashes.set(entry.record.image_file, await hashFile(join(imagesDir, entry.record.image_file)))
  }
  const context = { useImages, imagesDir, hashes }

  const cases = []
  const omittedVariants = []
  for (const variant of VARIANTS) {
    if (variant.requiresImages === true && !useImages) {
      omittedVariants.push({ variant: variant.name, reason: 'images not extracted or --no-images was used' })
      continue
    }
    for (const entry of selected.slice(0, variant.count)) {
      const caseId = `cord-${String(entry.index).padStart(4, '0')}-${variant.name}`
      const rows = rowsForVariant(entry, variant, context).map((row, rowIndex) => ({ ...row, caseId: rowIndex === 0 ? caseId : `${caseId}-row${rowIndex + 1}` }))
      const ledgerFile = join(outDir, `${caseId}.csv`)
      await writeFile(ledgerFile, toCsv(rows))
      cases.push({
        caseId,
        receiptIndex: entry.index,
        receipt: entry.record.image_file,
        variant: variant.name,
        expected: variant.expected,
        probe: variant.probe ?? null,
        description: variant.description,
        rows: rows.length,
        ledgerFile,
        numbers: {
          amount: formatCents(entry.numbers.amount),
          tax: formatCents(entry.numbers.tax),
          total: formatCents(entry.numbers.total),
        },
      })
    }
  }

  const manifest = {
    dataset: 'naver-clova-ix/cord-v2 test split',
    license: 'CC-BY-4.0',
    recordCount: records.length,
    dataDir,
    outDir,
    limit,
    selectedReceipts: selected.map((entry) => ({ index: entry.index, image: entry.record.image_file })),
    columns: useImages ? [...LEDGER_COLUMNS] : LEDGER_COLUMNS.filter((column) => column !== 'sourceFile' && column !== 'sha256'),
    fieldMapping: FIELD_MAPPING,
    absentFields: ABSENT_FIELDS,
    variants: VARIANTS.map(({ name, count, description, expected, probe }) => ({ name, count, description, expected, probe: probe ?? null })),
    omittedVariants,
    cases,
  }
  const manifestPath = join(outDir, 'cases.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { ...manifest, manifestPath }
}

function parseArgs(argv) {
  const args = { dataDir: process.env.CORD_DATA_DIR || DEFAULT_DATA_DIR, outDir: undefined, limit: 20, includeImages: true }
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--data': args.dataDir = argv[++i]; break
      case '--out': args.outDir = argv[++i]; break
      case '--limit': args.limit = Number(argv[++i]); break
      case '--no-images': args.includeImages = false; break
      case '--help': case '-h':
        console.log('usage: node bench/public-cord/adapter.mjs [--data DIR] [--out DIR] [--limit N] [--no-images]')
        process.exit(0)
      default: throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer')
  return args
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  buildBenchmark(args)
    .then((manifest) => {
      console.log(JSON.stringify({
        ok: true,
        outDir: manifest.outDir,
        manifest: manifest.manifestPath,
        cases: manifest.cases.length,
        columns: manifest.columns,
        omittedVariants: manifest.omittedVariants,
        license: manifest.license,
      }, null, 2))
    })
    .catch((error) => {
      console.error(`[adapter] ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
}
