# Changelog

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
