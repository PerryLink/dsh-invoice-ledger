#!/usr/bin/env node
/**
 * Fetch the CORD-v2 test artifacts used by this benchmark.
 *
 * The data is not committed. Two files are needed:
 *   - cord-test.jsonl.gz       100 test receipts, one JSON object per line
 *   - cord-test-images.zip     the 100 matching JPEGs
 *
 * Three acquisition paths, in order:
 *   1. the files are already in the cache directory (default: ./data);
 *   2. `--from <dir>` (or CORD_SEED_DIR) points at a directory that already
 *      has the two files, e.g. the pre-downloaded /tmp/public-data/cord;
 *   3. `--download` downloads from CORD_JSONL_URL / CORD_IMAGES_URL, or from the
 *      public Heliosoph/CORD mirror and then upstream Hugging Face when the env
 *      vars are unset. Every byte is checked against data.lock.json.
 *
 * Files are verified against data.lock.json (SHA-256 + byte size) unless
 * `--no-verify` is passed. The images are extracted to <data>/images for the
 * optional sourceFile/sha256 mapping; extraction needs `python3 -m zipfile`
 * or the `unzip` command and degrades to a warning when neither is present.
 *
 * Usage:
 *   node bench/public-cord/fetch.mjs --from /tmp/public-data/cord
 *   CORD_JSONL_URL=... CORD_IMAGES_URL=... node bench/public-cord/fetch.mjs --download
 *   node bench/public-cord/fetch.mjs --data-dir /tmp/cord-data
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = join(HERE, 'data')
const DEFAULT_SEED_DIR = '/tmp/public-data/cord'
const FILES = ['cord-test.jsonl.gz', 'cord-test-images.zip']
const DEFAULT_URLS = {
  'cord-test.jsonl.gz': [
    'https://hf-mirror.com/datasets/Heliosoph/CORD/resolve/main/cord-test.jsonl.gz',
    'https://huggingface.co/datasets/Heliosoph/CORD/resolve/main/cord-test.jsonl.gz',
  ],
  'cord-test-images.zip': [
    'https://hf-mirror.com/datasets/Heliosoph/CORD/resolve/main/cord-test-images.zip',
    'https://huggingface.co/datasets/Heliosoph/CORD/resolve/main/cord-test-images.zip',
  ],
}

function parseArgs(argv) {
  const args = { dataDir: process.env.CORD_DATA_DIR || DEFAULT_DATA_DIR, from: undefined, download: false, force: false, verify: true, extract: true }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    switch (token) {
      case '--data-dir': args.dataDir = argv[++i]; break
      case '--from': args.from = argv[++i]; break
      case '--download': args.download = true; break
      case '--force': args.force = true; break
      case '--no-verify': args.verify = false; break
      case '--no-extract': args.extract = false; break
      case '--help': case '-h':
        console.log('usage: node bench/public-cord/fetch.mjs [--data-dir DIR] [--from DIR] [--download] [--force] [--no-verify] [--no-extract]')
        process.exit(0)
      default:
        throw new Error(`unknown argument: ${token}`)
    }
  }
  args.dataDir = resolve(args.dataDir)
  if (args.from !== undefined) args.from = resolve(args.from)
  return args
}

async function sha256Of(path) {
  const bytes = await readFile(path)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }
}

async function readLock() {
  try {
    return JSON.parse(await readFile(join(HERE, 'data.lock.json'), 'utf8'))
  } catch {
    return undefined
  }
}

async function verifyFile(name, path, lock, enabled) {
  const info = await sha256Of(path)
  const expected = lock?.files?.[name]
  const result = { name, path, bytes: info.bytes, sha256: info.sha256, verified: false, expected: expected ?? null }
  if (expected === undefined) {
    if (enabled) console.warn(`[fetch] warning: ${name} has no lock entry; accepting it unverified`)
    return result
  }
  result.verified = info.sha256 === expected.sha256 && info.bytes === expected.bytes
  if (!result.verified && enabled) {
    throw new Error(
      `${name} does not match data.lock.json\n` +
      `  expected sha256 ${expected.sha256} (${expected.bytes} bytes)\n` +
      `  actual   sha256 ${info.sha256} (${info.bytes} bytes)\n` +
      'Pass --no-verify only when you intentionally changed the fixture.',
    )
  }
  return result
}

async function download(url, target) {
  if (url === undefined || url.trim() === '') throw new Error('download requested but the URL is empty')
  console.log(`[fetch] downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status} ${response.statusText}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const partial = `${target}.part`
  await writeFile(partial, bytes)
  await rename(partial, target)
  return bytes.byteLength
}

async function ensureFile(name, args, lock, used) {
  const target = join(args.dataDir, name)
  if (existsSync(target) && !args.force && !args.download) {
    used.push(`cache:${target}`)
    return target
  }
  if (args.download) {
    const envName = name === 'cord-test.jsonl.gz' ? 'CORD_JSONL_URL' : 'CORD_IMAGES_URL'
    const urls = process.env[envName] !== undefined && process.env[envName].trim() !== ''
      ? [process.env[envName]]
      : DEFAULT_URLS[name]
    let lastError
    for (const url of urls) {
      try {
        await download(url, target)
        used.push(`download:${url}`)
        return target
      } catch (error) {
        lastError = error
        console.warn(`[fetch] ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`could not download ${name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }
  const seed = args.from || process.env.CORD_SEED_DIR || (existsSync(DEFAULT_SEED_DIR) ? DEFAULT_SEED_DIR : undefined)
  if (seed !== undefined) {
    const source = join(seed, name)
    if (!existsSync(source)) throw new Error(`--from ${seed} does not contain ${name}`)
    await copyFile(source, target)
    used.push(`copy:${source}`)
    return target
  }
  throw new Error(
    `missing ${name}: no cached file, no --from directory, and --download was not requested.\n` +
    'Provide the two prepared artifacts (see README.md) or set CORD_JSONL_URL / CORD_IMAGES_URL and pass --download.',
  )
}

async function countImages(imagesDir) {
  if (!existsSync(imagesDir)) return 0
  return (await readdir(imagesDir)).filter((name) => /\.(?:jpe?g|png)$/iu.test(name)).length
}

function extractZip(zipPath, imagesDir) {
  const python = spawnSync('python3', ['-m', 'zipfile', '-e', zipPath, imagesDir], { encoding: 'utf8' })
  if (python.status === 0) return 'python3 -m zipfile'
  const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', imagesDir], { encoding: 'utf8' })
  if (unzip.status === 0) return 'unzip'
  return undefined
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await mkdir(args.dataDir, { recursive: true })
  const lock = await readLock()
  const used = []
  const files = []

  for (const name of FILES) {
    const path = await ensureFile(name, args, lock, used)
    files.push(await verifyFile(name, path, lock, args.verify))
  }

  let images = 0
  let extraction
  const imagesDir = join(args.dataDir, 'images')
  if (args.extract && existsSync(join(args.dataDir, 'cord-test-images.zip'))) {
    images = await countImages(imagesDir)
    if (images < 100) {
      extraction = extractZip(join(args.dataDir, 'cord-test-images.zip'), imagesDir)
      if (extraction === undefined) {
        console.warn('[fetch] warning: could not extract the image zip (python3/unzip unavailable); image-derived sourceFile/sha256 fields will be skipped')
      }
      images = await countImages(imagesDir)
    } else {
      extraction = 'already extracted'
    }
  }

  const summary = {
    ok: true,
    dataDir: args.dataDir,
    used,
    files: files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256, verified: file.verified })),
    images,
    imagesDir,
    extraction: extraction ?? null,
    license: lock?.license ?? 'CC-BY-4.0',
    source: lock?.source ?? 'https://huggingface.co/datasets/naver-clova-ix/cord-v2',
  }
  await writeFile(join(args.dataDir, 'fetch-report.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(`[fetch] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
