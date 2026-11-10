# Public-data benchmark: SROIE receipt keys

End-to-end benchmark for `dsh-invoice-ledger` using public SROIE receipt
annotations.

- Source: <https://github.com/zzzDavid/ICDAR-2019-SROIE>
- License: **MIT** (Copyright (c) 2019 Niansong Zhang, Songyi Yang, Shengjie Xiu)
- This pilot uses **3 keys** (`000`, `002`, `003`) because the raw GitHub
  endpoint was intermittently timing out during the run; `fetch.mjs` can fetch
  the full key set when the network is stable.
- Keys are downloaded under `.data/` and are **not** committed.

## What SROIE provides

`company`, `date`, `address`, `total` — no invoice code/number, tax amount,
tax rate, buyer or line items. The adapter maps `company → sellerName`,
`date → issueDate` (YYYY-MM-DD), `total → total`; it does not invent the rest.
Rules that need missing fields are excluded, not scored.

## Run

```bash
node bench/public-sroie/fetch.mjs
node bench/public-sroie/adapter.mjs
node bench/public-sroie/evaluate.mjs
```

`evaluate.mjs` calls the real tool from `../../lib/index.mjs`; clean rows are
real SROIE annotations; date/amount defects are injected.
