import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ingestToTable } from 'dsh-table-ingest/api'
import { Config } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import { check, loadPack } from './engine.ts'
import { buildWorkbook, renderMarkdown } from './report.ts'

export const name = 'dsh-invoice-ledger'
export const inject = ['tools']
export { Config }

/** Tool id exposed to the model, and the row id in `cordis.patch.yml`. */
export const TOOL_NAME = 'invoice_ledger'

/**
 * Resolve a package-owned file such as the rule pack.
 *
 * @param relative - configured path, relative to the package root.
 * @returns the resolved absolute path.
 */
export function resolvePackageFile(relative: string): string {
  if (isAbsolute(relative)) return relative
  const tried: string[] = []
  let directory = import.meta.dirname
  for (;;) {
    const candidate = join(directory, relative)
    tried.push(candidate)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const fromCwd = resolve(relative)
  if (existsSync(fromCwd)) return fromCwd
  throw new Error(`找不到 ${relative}；尝试过：\n${[...tried, fromCwd].join('\n')}`)
}

/**
 * Register the invoice ledger tool.
 *
 * @param ctx - plugin context, with `tools` already available.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: ConfigShape): () => void {
  return ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description:
        '核对发票台账：重复报销、价税合计勾稽、抬头是否本公司、开票日期、模板占位符。' +
        '只核对台账与票面自身的一致性与完整性，不判定虚开，不判定业务真实性，不替代税务机关查验。' +
        '本版本未实现的检查类型会在报告中逐条列出，未执行不等于通过。',
      parameters: {
        file: { type: 'string', description: '台账文件绝对路径（.xlsx / .xlsm / .csv）。' },
        today: { type: 'string', description: '核对基准日（YYYY-MM-DD），用于日期未来与时限判断；默认今天。' },
        rulePackFile: { type: 'string', description: '覆盖配置中的规则库路径。' },
        outFile: { type: 'string', description: '异常工作簿写到哪里；留空用配置里的默认文件名。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            plugin: { type: 'string' },
            target: { type: 'string' },
            packVersion: { type: 'string' },
            summary: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rows: { type: 'integer' },
                errors: { type: 'integer' },
                warnings: { type: 'integer' },
                infos: { type: 'integer' },
              },
            },
            findingCount: { type: 'integer' },
            unsupportedCount: { type: 'integer' },
            unsupported: { type: 'array', items: { type: 'string' } },
            markdown: { type: 'string' },
            resultJson: { type: 'string' },
            workbookPath: { type: 'string' },
            workbookBase64: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: (value as { markdown: string }).markdown }],
      },
      timeoutMs: config.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (args.file === undefined || args.file.trim() === '') throw new Error('必须提供 file')
        const path = resolve(args.file)
        exec.signal.throwIfAborted()
        const buffer = await readFile(path)

        const packPath = resolvePackageFile(args.rulePackFile?.trim() || config.rulePackFile)
        const pack = loadPack(await readFile(packPath, 'utf8'))

        const ingested = ingestToTable(buffer, path)
        if (!ingested.ok || ingested.table === undefined) {
          throw new Error(`无法从 ${path} 抽出表格：${ingested.error ?? '未知原因'}`)
        }
        exec.signal.throwIfAborted()

        const today = args.today?.trim() || new Date().toISOString().slice(0, 10)
        const result = check(pack, ingested.table, today)
        const markdown = renderMarkdown(result, path, pack.version)
        const workbook = buildWorkbook(result)

        const target = args.outFile !== undefined && args.outFile.trim() !== '' ? resolve(args.outFile) : resolve(config.workbook)
        let workbookPath = ''
        try {
          await writeFile(target, workbook)
          workbookPath = target
        } catch {
          workbookPath = ''
        }

        return {
          plugin: name,
          target: path,
          packVersion: pack.version,
          summary: result.summary,
          findingCount: result.findings.length,
          unsupportedCount: result.unsupported.length,
          unsupported: result.unsupported.map((rule) => `${rule.id} ${rule.title} (${rule.kind})`),
          markdown,
          resultJson: JSON.stringify(result),
          workbookPath,
          workbookBase64: workbook.toString('base64'),
        }
      },
    }),
  )
}
