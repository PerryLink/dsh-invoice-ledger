# dsh-invoice-ledger — Invoice ledger (Português)

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

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

**Boundary:** TODO 与最接近的既有做法划清界限——本插件做什么、明确不做什么。

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

Full family index: [choose a checker by material](https://perrylink.github.io/zh/checkers/choose/) and [all plugins](https://github.com/PerryLink). This repository is one of them.

## License

[Apache License 2.0](LICENSE) © 2026 dsh-invoice-ledger contributors.
