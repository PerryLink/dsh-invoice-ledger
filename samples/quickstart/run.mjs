/**
 * Minimal first run for dsh-invoice-ledger.
 *
 * Input: `input/invoices.csv` is a hand-written synthetic ledger (one invoice
 * per row). It carries one duplicate, one total that does not add up, and one
 * invoice dated in the future relative to the pinned `today` below.
 *
 * `today` is pinned so the expected output does not change with the wall clock.
 *
 *   node samples/quickstart/run.mjs           human-readable summary
 *   node samples/quickstart/run.mjs --json    the same summary as JSON
 *   node samples/quickstart/run.mjs --check   compare against expected/result.json
 */
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../../lib/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// The tool also writes an anomaly workbook. Put it in the OS temp directory so
// running the sample never touches the checkout.
const outFile = join(tmpdir(), 'dsh-invoice-ledger-quickstart', 'invoice-anomalies.xlsx')
try { await mkdir(dirname(outFile), { recursive: true }) } catch { /* read-only temp is fine */ }

const registered = []
const ctx = { tools: { register: (tool) => { registered.push(tool); return () => {} } } }
plugin.apply(ctx, plugin.Config({}))
const tool = registered.find((t) => t.name === plugin.TOOL_NAME)
if (!tool) throw new Error('tool not registered: ' + plugin.TOOL_NAME)

const result = await tool.execute(
  {
    file: join(here, 'input', 'invoices.csv'),
    today: '2026-10-15',
    outFile,
  },
  { signal: new AbortController().signal },
)

const summary = {
  tool: tool.name,
  today: '2026-10-15',
  summary: result.summary,
  findingCount: result.findingCount,
  unsupportedCount: result.unsupportedCount,
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2))
} else if (process.argv.includes('--check')) {
  const expected = JSON.parse(await readFile(join(here, 'expected', 'result.json'), 'utf8'))
  if (JSON.stringify(summary, null, 2) !== JSON.stringify(expected, null, 2)) {
    console.error('quickstart: output differs from expected/result.json')
    console.error('--- expected\n' + JSON.stringify(expected, null, 2))
    console.error('--- actual\n' + JSON.stringify(summary, null, 2))
    process.exit(1)
  }
  console.log(`${tool.name}: quickstart OK — output matches expected/result.json`)
} else {
  const s = summary.summary
  console.log('$ node samples/quickstart/run.mjs')
  console.log(
    `${tool.name}: ${s.rows} rows, ${summary.findingCount} finding(s) — ` +
      `${s.errors} error, ${s.warnings} warn, ${s.infos} info; ` +
      `${summary.unsupportedCount} rule(s) not executed`,
  )
}
