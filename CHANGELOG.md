# Changelog

## 0.1.6

### Added

- All 26 rule kinds are now implemented: line totals/math, form totals, tax-rate/status/equation, age, numeric range, concentration, consecutive runs, rate-vs-category, file hashes/source links, red-letter linkage and the coverage meta-rule.
- Folder-level `dsh-invoice-batch` runner; it reuses the single-file rule engine.
- Execution ledger with separate `executed` / `skipped` / `manual` / `unsupported` counts.

### Changed

- Docs are en/zh only; the batch tool and capability card document the remaining data requirements instead of claiming a pass.

## Unreleased

### Fixed

- `${profile.company.name}` / `${profile.company.taxId}` were not resolved: the lookup table did not contain them and the template pattern rejected dotted paths, so the literal text reached INV-009. The company's own tax id was reported as "not this company", with `${profile.company.taxId}` printed as the expected value. Both paths now resolve from `profile.company`.
- `${profile.companyStartDate}` was mapped to an empty string, and the date-window check never read `minDate` — so INV-002's lower bound could not run. The date is now loaded from the profile, and an issue date earlier than it is reported at `beforeMinDateSeverity` (warn for the shipped pack). The lower bound is inclusive.
- INV-010 compared `sellerName` / `sellerTaxId` with our own company master data, so every ledger that names its sellers reported `sellerName 不是本公司` (and would have reported the seller tax id too). Seller-side matching no longer compares the counterparty with the company; it only checks that the seller name is filled when the pack sets `requireName` and the ledger carries the column. Format and checksum validation stay with the rule pack.
- Adds 5 regression tests (27 total).

## 0.1.1

- Require `dsh-table-ingest` `^0.2.1`, which adds the ZIP entry-count, per-entry and cumulative output budgets requested in the dshopen review. No rule or report change.

## 0.1.0

First release. Implements 8 of the pack's check kinds; the rest are reported as
not executed, by name.

- `invoiceKey`, `moneyEquation`, `uniqueInvoice`, `duplicateAcross`,
  `dateWindow`, `partyMatch`, `partyCompare`, `placeholderScan`.
- **Duplicates are keyed on code + number, never on the amount**, so an amount
  typo still surfaces as a duplicate. The 20-digit number is kept as a string:
  it exceeds the safe integer range and converting loses the last digits.
- A difference explained by a recognised special case (差额征税, 通行费,
  成品油) is downgraded to a warning, not hidden.
- The report lists unexecuted rules before findings, and says explicitly that
  "not executed" is not "passed".
- Fixes a defect in the shipped rule pack: the placeholder patterns included an
  unanchored `00000000`, which matches the sequential part of nearly every
  数电票 number, so every invoice would have been flagged as a template
  placeholder. Patterns are now anchored and a test covers it.
- 22 tests.
