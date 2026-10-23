import Schema from '@deepseek-ai/schemastery'

/** Tunables an operator can change from `cordis.yml`. */
export interface Config {
  /** Tool timeout budget in milliseconds. */
  timeoutMs: number
  /** Rule-pack path relative to the package root. */
  rulePackFile: string
  /** Where to write the anomaly workbook. */
  workbook: string
}

export const Config: Schema<Config> = Schema.object({
  timeoutMs: Schema.number().default(120_000).description('工具超时预算（毫秒）。'),
  rulePackFile: Schema.string().default('rules/invoice-ledger.yaml').description('规则库路径。'),
  workbook: Schema.string().default('invoice-anomalies.xlsx').description('异常工作簿输出文件名；留空则只返回 base64。'),
})
