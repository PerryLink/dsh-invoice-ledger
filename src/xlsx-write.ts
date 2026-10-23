/**
 * Minimal xlsx writer.
 *
 * A workbook is a ZIP of XML parts. Writing one by hand avoids carrying `exceljs`
 * (20.8 MB unpacked) into a package whose whole budget is 3 MB — and the subset a
 * reconciliation report needs is small: a header row, string and number cells,
 * a frozen pane, an autofilter and a few fills.
 *
 * Two constraints shape the output:
 *
 *  - **A header row must be a single row.** Merged header cells disable
 *    autofilter in Excel, so the writer never merges.
 *  - **A value that looks like a number is still written as a number**, but an
 *    identifier is written as a string, otherwise a 20-digit invoice number
 *    becomes `2.61412E+19` and loses its last digits.
 */

import { deflateRawSync } from 'node:zlib'

/** One cell in the output sheet. */
export type Cell = string | number | null

/** One sheet of the output workbook. */
export interface Sheet {
  /** Tab name, at most 31 characters, without `[]:*?/\\`. */
  name: string
  /** Header row; every column is a single cell, never merged. */
  header: string[]
  /** Body rows, in the same column order as `header`. */
  rows: Cell[][]
  /** Column widths in characters; missing entries default to 14. */
  widths?: number[]
  /** Index of a column to freeze after (0-based); -1 freezes only the header. */
  freezeAfterColumn?: number
}

/** Raised when the requested workbook cannot be represented. */
export class XlsxWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XlsxWriteError'
  }
}

/** CRC-32 of a buffer, as required by the ZIP central directory. */
function crc32(buffer: Buffer): number {
  let table = CRC_TABLE
  if (table === undefined) {
    table = new Int32Array(256)
    for (let index = 0; index < 256; index++) {
      let value = index
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      table[index] = value
    }
    CRC_TABLE = table
  }
  let crc = -1
  for (const byte of buffer) crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0)
  return (crc ^ -1) >>> 0
}

let CRC_TABLE: Int32Array | undefined

/** One entry to be written into the archive. */
interface ZipEntry {
  name: string
  data: Buffer
}

/**
 * Build a ZIP archive with stored-then-deflated entries.
 *
 * Deflate is used only when it actually shrinks the payload; XML compresses well,
 * and a stored entry avoids the round-trip cost for tiny parts.
 *
 * @param entries - files to include, in the order they should appear.
 * @returns the archive bytes.
 */
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const deflated = deflateRawSync(entry.data, { level: 6 })
    const useDeflate = deflated.length < entry.data.length
    const payload = useDeflate ? deflated : entry.data
    const method = useDeflate ? 8 : 0
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + payload.length
  }

  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...centrals, end])
}

/** Escape the five XML metacharacters plus the control characters Excel rejects. */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
    // XML 1.0 forbids most C0 controls; Excel refuses to open a file containing them.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '')
}

/**
 * Convert a zero-based column index to letters (`0` → `A`, `26` → `AA`).
 *
 * @param index - zero-based column.
 * @returns the column letters.
 */
export function columnLetters(index: number): string {
  let remaining = index + 1
  let letters = ''
  while (remaining > 0) {
    const digit = (remaining - 1) % 26
    letters = String.fromCharCode(65 + digit) + letters
    remaining = Math.floor((remaining - 1) / 26)
  }
  return letters
}

/** One cell rendered as `<c>`, choosing the string table or a numeric value. */
function cellXml(reference: string, value: Cell, styleIndex: number, sharedIndex: Map<string, number>, shared: string[]): string {
  if (value === null || value === '') return `<c r="${reference}" s="${styleIndex}"/>`
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}" s="${styleIndex}"><v>${value}</v></c>`
  }
  const text = String(value)
  let index = sharedIndex.get(text)
  if (index === undefined) {
    index = shared.length
    shared.push(text)
    sharedIndex.set(text, index)
  }
  return `<c r="${reference}" s="${styleIndex}" t="s"><v>${index}</v></c>`
}

/** Inline styles: 0 default, 1 header (bold, filled), 2 wrap. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

/**
 * Render one worksheet part.
 *
 * @param sheet - the sheet to render.
 * @param shared - the workbook's shared string table, appended to in place.
 * @param sharedIndex - reverse index of `shared`.
 * @returns the worksheet XML.
 */
function sheetXml(sheet: Sheet, shared: string[], sharedIndex: Map<string, number>): string {
  const columns = sheet.header.length
  const widths = sheet.widths ?? []
  const cols =
    columns === 0
      ? ''
      : `<cols>${Array.from({ length: columns }, (_, index) => {
          const width = widths[index] ?? 14
          return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
        }).join('')}</cols>`

  const headerCells = sheet.header
    .map((title, index) => cellXml(`${columnLetters(index)}1`, title, 1, sharedIndex, shared))
    .join('')
  const headerRow = `<row r="1">${headerCells}</row>`

  const bodyRows = sheet.rows
    .map((row, rowIndex) => {
      const reference = rowIndex + 2
      const cells = row
        .map((value, columnIndex) => cellXml(`${columnLetters(columnIndex)}${reference}`, value, 2, sharedIndex, shared))
        .join('')
      return `<row r="${reference}">${cells}</row>`
    })
    .join('')

  const lastColumn = columnLetters(Math.max(columns - 1, 0))
  const lastRow = sheet.rows.length + 1
  const freezeAfter = sheet.freezeAfterColumn ?? -1
  const pane =
    freezeAfter >= 0
      ? `<pane xSplit="${freezeAfter + 1}" ySplit="1" topLeftCell="${columnLetters(freezeAfter + 1)}2" activePane="bottomRight" state="frozen"/>`
      : `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
<dimension ref="A1:${lastColumn}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0">${pane}<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols}
<sheetData>${headerRow}${bodyRows}</sheetData>
<autoFilter ref="A1:${lastColumn}${lastRow}"/>
</worksheet>`
}

/**
 * Build an `.xlsx` file from a list of sheets.
 *
 * @param sheets - sheets in tab order; at least one.
 * @returns the workbook bytes.
 * @throws XlsxWriteError when a sheet name is invalid or the list is empty.
 */
export function writeWorkbook(sheets: Sheet[]): Buffer {
  if (sheets.length === 0) throw new XlsxWriteError('工作簿至少要有一张表')
  const seen = new Set<string>()
  for (const sheet of sheets) {
    if (sheet.name === '') throw new XlsxWriteError('工作表名不能为空')
    if (sheet.name.length > 31) throw new XlsxWriteError(`工作表名「${sheet.name}」超过 31 字符`)
    if (/[[\]:*?/\\]/u.test(sheet.name)) throw new XlsxWriteError(`工作表名「${sheet.name}」含有 Excel 不允许的字符`)
    if (seen.has(sheet.name)) throw new XlsxWriteError(`工作表名「${sheet.name}」重复`)
    seen.add(sheet.name)
  }

  const shared: string[] = []
  const sharedIndex = new Map<string, number>()
  const worksheets = sheets.map((sheet) => sheetXml(sheet, shared, sharedIndex))

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
${worksheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
</workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`

  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">
${shared.map((text) => `<si><t xml:space="preserve">${xmlEscape(text)}</t></si>`).join('')}
</sst>`

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStrings, 'utf8') },
    ...worksheets.map((xml, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: Buffer.from(xml, 'utf8'),
    })),
  ]
  return zip(entries)
}
