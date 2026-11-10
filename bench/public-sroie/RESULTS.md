# Results — SROIE pilot

Rows: 3; source: SROIE receipt keys (MIT).

| rule | TP | FP | FN | TN | precision | recall |
|---|---:|---:|---:|---:|---:|---:|
| INV-002 date window | 6 | 0 | 0 | 9 | 1.000 | 1.000 |
| INV-023 amount range | 6 | 0 | 0 | 9 | 1.000 | 1.000 |

## Limits

- Three keys only; this is a pilot, not a dataset-level P/R.
- SROIE receipts are Malaysian, not Chinese VAT invoices.
- No invoice number, tax amount, buyer or line items; those rules are excluded.
- Date/amount defects are injected; clean rows are real annotations.
