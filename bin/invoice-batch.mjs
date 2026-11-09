#!/usr/bin/env node
/**
 * CLI for the folder-level invoice runner.
 *
 * Usage:
 *   dsh-invoice-batch --dir <folder> [--today YYYY-MM-DD] [--out result.json] [--recursive]
 *
 * The single-file tool stays the review surface; this command is the job surface.
 */
import { runBatch } from '../lib/batch.mjs'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const dir = value('--dir', '')
if (dir === '') {
  console.error('用法：dsh-invoice-batch --dir <目录> [--today YYYY-MM-DD] [--out result.json] [--recursive]')
  process.exit(2)
}
try {
  const result = await runBatch({
    dir,
    ...(value('--today', '') === '' ? {} : { today: value('--today', '') }),
    ...(value('--out', '') === '' ? {} : { outFile: value('--out', '') }),
    recursive: args.includes('--recursive'),
  })
  console.log(result.markdown)
  if (value('--out', '') !== '') console.error(`JSON written to ${value('--out', '')}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
