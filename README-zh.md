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

TODO 一段话说明 dsh-invoice-ledger 读什么材料、核对什么、不作出什么结论。

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

TODO 列出它回答的问题。

## Standards it follows

TODO 列出所依据的文件与条款。

## Compatibility

| Surface | Status |
|---|---|
| Harness | peer range `>=0.1.2-rc.1 <0.2.0 \|\| >=0.2.0-0 <0.3.0` |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | all (pure ESM; no native code, no network, no model call) |

## What it does

TODO 说明规则表与行为细节。

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `rulesFile` | `rules/invoice-ledger.yaml` | 规则库路径 |

## Material format

TODO 给出完整字段示例。

## Rule sources

TODO 说明规则数据与代码分离、取证纪律与已知边界。

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
