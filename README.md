# dsh-invoice-ledger — Invoice ledger

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

<!-- topblock:v1 -->
> **What it is** — Checks an invoice ledger for duplicate claims, tax arithmetic, payee names, dates and leftover placeholders.
> **Who it is for** — finance and expense reviewers.
> **What you give it** — an invoice ledger table
> **What it does not do** — no compliance verdict, no liability finding, no replacement for the reviewer; differences only.
> **How to start** — from the command line (not sold separately yet):
> `dsh plugin --profile <name> add dsh-invoice-ledger`
<!-- /topblock:v1 -->

[![dshfind](https://dshfind.com/api/badge/PerryLink/dsh-invoice-ledger?metric=downloads)](https://dshfind.com/en/plugins/PerryLink/dsh-invoice-ledger?ref=badge)

`dsh-invoice-ledger` checks an invoice ledger for duplicates, arithmetic consistency, payer mismatch, date anomalies and template placeholders left in a cell, and emits an anomaly list plus a workbook.

Two things are deliberate. A duplicate is keyed on **code + number, never on the amount**, so an amount typo still surfaces as a duplicate. And the report lists, by name, every rule this version could not execute: a ledger with four findings and fourteen unexecuted rules is not four problems.

## Install

```sh
dsh plugin --profile <name> add dsh-invoice-ledger
dsh --profile <name> --dump-config | grep 'dsh-invoice-ledger'
```

## What it looks like

![Workflow diagram for dsh-invoice-ledger: document → rule pack → findings.](docs/assets/dsh-invoice-ledger-flow.svg)

*Workflow overview: document → rule pack → findings.*

**Boundary:** this checks the ledger against itself and against the invoice face. It does not decide whether an invoice is fake, does not verify business substance, does not query the tax authority, and does not replace a finance review. Rate-versus-goods, consecutive numbering and same-day clustering are risk prompts, not conclusions. The 数电票 number is kept as a string throughout: 20 digits exceed JavaScript's safe integer range, and converting loses the last digits — which would make two different invoices compare equal.

## What it answers

- Is the same invoice recorded twice, possibly across two reimbursement forms?
- Does the total equal amount plus tax, within the configured tolerance?
- Is the buyer actually this company, or a registered branch?
- Is the issue date in the period, not in the future, and inside the internal deadline?
- Which cells still hold template text such as `XX公司`?

And, explicitly: which rules did **not** run?

## Standards it follows

The pack cites the documents its rules come from, verbatim. For example:

- 数电票 numbering: 国家税务总局公告 2024 年第 11 号 第四条 — a 20-digit number whose first two digits are the year, digits 3–4 the provincial region, digit 5 the issuance channel, 6–20 a sequence.
- The arithmetic identities (total = amount + tax) are marked `arithmetic` rather than given a fabricated citation, because they are identities, not regulations.
- Rules with no citable clause say so in their own `excerpt` rather than inventing one.

## Compatibility

| Surface | Status |
|---|---|
| Harness | peer range `>=0.1.2-rc.1 <0.2.0 \|\| >=0.2.0-0 <0.3.0` |
| Node | `^22.19.0 || >=24.0.0` |
| Platforms | all (pure ESM; no native code, no network, no model call) |

## What it does

The pack declares `params.check.kind` per rule. This version implements: `invoiceKey`, `moneyEquation`, `uniqueInvoice`, `duplicateAcross`, `dateWindow`, `partyMatch`, `partyCompare`, `placeholderScan`. Everything else is reported as not executed, with its kind named.

A difference that a recognised special case explains — 差额征税, 通行费, 成品油 in the remark — is **downgraded to a warning, not hidden**: the reader still sees the number and decides.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `rulesFile` | `rules/invoice-ledger.yaml` | 规则库路径 |

## Material format

One row per invoice. Fields read by the shipped pack include `invoiceCode`, `invoiceNumber`, `docType`, `issueDate`, `amount`, `tax`, `total`, `buyerName`, `buyerTaxId`, `sellerName`, `sellerTaxId`, `formNo`, `reimburser`, `remark`.

The workbook has three sheets: 汇总, 异常清单 (one row per finding) and 未执行规则.

## Rule sources

Quotations live in the pack, next to the rule that uses them, and `check:citations` verifies each appears verbatim.

A defect in the shipped pack is worth recording: its placeholder patterns included an unanchored `00000000`, which matches the sequential part of almost every 20-digit 数电票 number. Every invoice would have been flagged as a template placeholder. The patterns are now anchored, and a test asserts that a real number is not flagged.

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
