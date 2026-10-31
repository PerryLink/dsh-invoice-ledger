# dsh-invoice-ledger — 发票台账异常核对

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

<!-- topblock:v1 -->
> **这是什么**　把发票台账逐行看一遍：重复报销、价税勾稽、抬头、日期、模板占位符。
> **给谁用**　财务、报销审核岗。
> **你交什么**　一份发票台账（表格）；不改原件。
> **它不做什么**　不判合规、不认定责任、不替代审核人；只列材料内部能逐条指认的差异。
> **怎么开始**　命令行安装（暂未单独上架）：
> `dsh plugin --profile <name> add dsh-invoice-ledger`
<!-- /topblock:v1 -->

[![dshfind](https://dshfind.com/api/badge/PerryLink/dsh-invoice-ledger?metric=downloads)](https://dshfind.com/en/plugins/PerryLink/dsh-invoice-ledger?ref=badge)

`dsh-invoice-ledger` 核对一份发票台账：重复报销、价税算术、购方抬头、日期异常、单元格里残留的模板文字，输出一份异常清单和一份工作簿。

有两处是刻意的。判重只看**发票代码 + 号码，不看金额**，所以金额写错也仍会被判为重复。报告会逐一列出这一版**没有执行**的规则：一份台账报了 4 条差异、另有 14 条规则没跑，不等于只有 4 个问题。

## Install

```sh
dsh plugin --profile <name> add dsh-invoice-ledger
dsh --profile <name> --dump-config | grep 'dsh-invoice-ledger'
```

## What it looks like

![Workflow diagram for dsh-invoice-ledger: document → rule pack → findings.](docs/assets/dsh-invoice-ledger-flow.svg)

*Workflow overview: document → rule pack → findings.*

**边界（中文译文，以英文原文为准）：** 本插件核对台账内部及台账与发票票面之间的一致性；不判断发票真伪，不核实业务实质，不查询税务机关，也不替代财务复核。税率与货物、连号、同日聚集等只是风险提示，不是结论。数电票号码全程按字符串保存：20 位超出 JavaScript 安全整数范围，转成数字会丢失末位，导致两张不同发票被判为相同。

## What it answers

- 同一张发票有没有被记两次，甚至跨两张报销单？
- 价税合计在容差内是否等于金额加税额？
- 购方到底是不是本公司，或是已登记的分支机构？
- 开票日期是否落在所属期内、不在未来、也在内部申报期限之内？
- 哪些单元格还留着 `XX公司` 这类模板文字？

以及一个必须回答的问题：**哪些规则没有跑？**

## Standards it follows

规则库逐字引用它所依据的文件。例如：

- 数电票号码：国家税务总局公告 2024 年第 11 号 第四条——20 位号码，前两位是年份，3–4 位是省级区域，第 5 位是开具渠道，6–20 位是顺序码。
- 算术恒等式（合计 = 金额 + 税额）标为 `arithmetic`，不编造条文引用，因为它是恒等式，不是法规。
- 没有可引条文的规则，在自己的 `excerpt` 里如实写明，而不是编一条。

## Compatibility

| Surface | Status |
|---|---|
| Harness | peer range `>=0.1.2-rc.1 <0.2.0 \|\| >=0.2.0-0 <0.3.0` |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | all (pure ESM; no native code, no network, no model call) |

## What it does

规则库逐条声明 `params.check.kind`。这一版实现了：`invoiceKey`、`moneyEquation`、`uniqueInvoice`、`duplicateAcross`、`dateWindow`、`partyMatch`、`partyCompare`、`placeholderScan`。其余规则会按名称列为「未执行」。

有已识别的特殊情形可以解释的差异——差额征税、通行费、成品油写在备注里——会**降级为警告而不是隐藏**：读者仍然看得到这个数字，由人决定。

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `rulesFile` | `rules/invoice-ledger.yaml` | 规则库路径 |

## Material format

一行一张发票。随包规则库读取的字段包括 `invoiceCode`、`invoiceNumber`、`docType`、`issueDate`、`amount`、`tax`、`total`、`buyerName`、`buyerTaxId`、`sellerName`、`sellerTaxId`、`formNo`、`reimburser`、`remark`。

工作簿有三张表：汇总、异常清单（一条发现一行）、未执行规则。

## Rule sources

引文就在规则库里、紧挨着使用它的规则；`check:citations` 校验每一条都逐字出现。

随包规则库有一个值得记下的缺陷：占位符模式里有一条未加锚点的 `00000000`，几乎能匹配每一张 20 位数电票号码的顺序段——每一张发票都会被报成模板占位符。现在模式已加锚点，并有测试断言真实号码不会被报出。

## Troubleshooting

- **The plugin installs but the tool never appears**: check that `main` resolves to `lib/index.mjs` and that `pnpm run build` produced it.
- **`dsh plugin add` rejects the package**: the peer range covers `0.1.x` and `0.2.x`; outside it, grant an explicit exemption.
- **A rule did not run**: read the `skipped` array.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
node ../scripts/sync-shared.mjs dsh-invoice-ledger
```

## PerryLink DSH Plugin Family

完整清单（62 个核查器 + 通用插件）见 [按材料选核查器](https://perrylink.github.io/zh/checkers/choose/)；本仓只是其中一个。

## License

[Apache License 2.0](LICENSE) © 2026 dsh-invoice-ledger contributors.
