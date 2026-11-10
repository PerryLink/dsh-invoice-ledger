#!/usr/bin/env node
/**
 * Fetch the public SROIE receipt key annotations.
 *
 * Source: https://github.com/zzzDavid/ICDAR-2019-SROIE
 * License: MIT (Copyright (c) 2019 Niansong Zhang, Songyi Yang, Shengjie Xiu)
 *
 * SROIE keys contain company, date, address and total. They do not contain
 * invoice code/number, tax amount, tax rate, buyer, or line items.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '.data')
await mkdir(dir, { recursive: true })
for (let index = 0; index < 3; index += 1) {
  const id = String(index).padStart(3, '0')
  const url = `https://raw.githubusercontent.com/zzzDavid/ICDAR-2019-SROIE/master/data/key/${id}.json`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed: ${id}: ${response.status}`)
  const text = await response.text()
  JSON.parse(text)
  await writeFile(join(dir, `${id}.json`), text)
}
console.log(`wrote 3 SROIE keys to ${dir}`)
