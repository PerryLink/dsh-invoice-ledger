# CORD-v2 public-data benchmark

End-to-end benchmark for the real `invoice_ledger` tool shipped by this repository. It turns the public
[CORD-v2](https://huggingface.co/datasets/naver-clova-ix/cord-v2) receipt annotations into the CSV ledger
shape the plugin reads, calls the registered tool from [`lib/index.mjs`](../../lib/index.mjs), and scores the
returned findings against labelled defects.

The benchmark is deliberately narrow: CORD has receipt totals but **no invoice number, date, buyer, seller
or tax rate**. Those rules are marked *not provided* and excluded rather than fed invented values. See
[Rule coverage](#rule-coverage) and [Limitations](#limitations).

## Data source and license

- Dataset: **CORD-v2**, test split, 100 receipts.
- Canonical source: <https://huggingface.co/datasets/naver-clova-ix/cord-v2>
- Public mirror serving the two prepared artifacts:
  <https://huggingface.co/datasets/Heliosoph/CORD> (verified byte-for-byte against
  `data.lock.json`)
- Paper: Park et al., *CORD: A Consolidated Receipt Dataset for Post-OCR Parsing*,
  <https://arxiv.org/abs/2103.10213>
- License: **Creative Commons Attribution 4.0 International (CC BY 4.0)**,
  <https://creativecommons.org/licenses/by/4.0/>. The dataset card declares `license: cc-by-4.0`.
- Attribution: **NAVER Clova / the CORD authors**. This benchmark redistributes no CORD data; the files are
  fetched into the ignored `data/` directory and the annotations are transformed at run time.
- This repository's plugin code remains under its own Apache-2.0 license. The CC BY 4.0 obligation applies to
  the CORD data and to any redistributed adaptation of it; `summary.json` contains derived numeric values and
  labels, not the receipt images or OCR text.

The two prepared artifacts used here are:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `cord-test.jsonl.gz` | 80,827 | `a2aed84c8b507d68f554def4a60e4749e2c74b64cd40d30cbb50b7c32619f1e2` |
| `cord-test-images.zip` | 20,962,139 | `f08e97ddab89ba02422948c41289ac4a32221d76cbdd131828e6bc37cdc822d6` |

`data.lock.json` pins those bytes. `fetch.mjs` verifies them on copy/download. Hugging Face currently stores the
test split as Parquet; the two files above are the prepared JSONL/JPEG bundle used by this benchmark. If you
regenerate the bundle from the Parquet source, update `data.lock.json` intentionally rather than silently
accepting different bytes.

## Files

| File | Purpose |
| --- | --- |
| `fetch.mjs` | Obtain and verify the two CORD artifacts; extract the JPEGs to `data/images/`. No data is committed. |
| `adapter.mjs` | Map `gt_parse` to the plugin's ledger columns, build clean and defect cases, write one CSV per case to a temp directory (or `--out`). |
| `evaluate.mjs` | Build the cases, register the real plugin, call `invoice_ledger` on every CSV, compute per-rule P/R, and write `summary.json` / `RESULTS.md`. |
| `data.lock.json` | Source/license metadata and SHA-256/size pins for the two public artifacts. |
| `summary.json` | Machine-readable run result: case labels, plugin findings, P/R, exclusions, raw output, limitations. |
| `RESULTS.md` | Short generated report (do not edit by hand). |

## Quick start

From the repository root:

```sh
node bench/public-cord/fetch.mjs --from /tmp/public-data/cord
node bench/public-cord/evaluate.mjs --limit 20
```

`fetch.mjs` has three acquisition paths:

1. cache: the two files already exist in `bench/public-cord/data/`;
2. `--from DIR` (or `CORD_SEED_DIR`): copy the pre-downloaded bundle, e.g. `/tmp/public-data/cord`;
3. `--download`: fetch the two pinned artifacts from the public Heliosoph/CORD mirror (default), then
   upstream Hugging Face as fallback:

```sh
node bench/public-cord/fetch.mjs --download
```

`CORD_JSONL_URL` / `CORD_IMAGES_URL` override the URL for either file. The lock file rejects a different
byte stream unless `--no-verify` is passed.

The recorded benchmark run used `--from /tmp/public-data/cord` against the already-downloaded public bundle.
The `--download` path was also exercised separately against the public mirror; both SHA-256 hashes matched
`data.lock.json` (80,827 bytes and 20,962,139 bytes respectively).

To inspect the generated ledgers without running the plugin:

```sh
node bench/public-cord/adapter.mjs --limit 20 --out /tmp/cord-ledgers
cat /tmp/cord-ledgers/cord-0005-clean.csv
```

`adapter.mjs` defaults to a fresh OS temp directory too; `--out` only exists for inspection. Generated ledgers,
the fetched data and the anomaly workbooks are ignored by `bench/public-cord/.gitignore` and the repository
root `.gitignore`.

## Field mapping

The plugin reads canonical ledger keys from [`src/engine.ts`](../../src/engine.ts) and the shipped pack in
[`rules/invoice-ledger.yaml`](../../rules/invoice-ledger.yaml). The adapter writes only these columns:

| Ledger column | CORD source | Transform | In P/R? |
| --- | --- | --- | --- |
| `amount` | `ground_truth.gt_parse.sub_total.subtotal_price` | decimal -> integer cents -> 2dp, half away from zero | yes (INV-003) |
| `tax` | `ground_truth.gt_parse.sub_total.tax_price` | same | yes (INV-003) |
| `total` | `ground_truth.gt_parse.total.total_price` | same | yes (INV-003, INV-023) |
| `sourceFile` | `image_file`, extracted JPEG | absolute path to the public image | yes (INV-007, INV-024) |
| `sha256` | bytes of that JPEG | SHA-256 hex | yes (INV-007 lookups) |
| `caseId` | benchmark case id | synthetic row id; ignored by the plugin | no (diagnostic only) |

The following fields are **not provided by CORD** and are not written at all (not blank, not placeholder):
`invoiceCode`, `invoiceNumber`, `docType`, `issueDate`, `taxRate`, `buyerName`, `buyerTaxId`, `sellerName`,
`sellerTaxId`, `formNo`, `formAmount`, `reimburser`, `remark`, `lineAmount`, `lineTax`, `quantity`, `unitPrice`,
`unit`, `isRed`, `originalInvoiceNumber`.

The three money values are real CORD values, not synthetic. `sourceFile`/`sha256` are derived from the public
JPEGs. `caseId` is the only synthetic column and is ignored by the plugin.

### Why only these fields?

`gt_parse` contains `menu` (item name/price/quantity), `sub_total` (subtotal, tax, discount, service) and
`total` (total, cash/card change). It does **not** contain an invoice code/number, issue date, buyer, seller,
tax rate, form number, reimburser, remark, line tax or red-letter marker. CORD is an Indonesian receipt corpus,
not a Chinese VAT invoice corpus. Filling those fields would fabricate data and make the plugin's checks look
better than they are. The benchmark therefore maps only what exists and excludes the rest.

Money is normalised to the plugin's 2-decimal model. Some CORD receipts carry three decimals (e.g.
`5.455`); converting them to integer cents and rounding half away from zero is a format transformation, not a
new annotation. The 20 selected receipts are the first test-split records with all three money fields and
`|amount + tax - total| <= 0.02` after that rounding.

## Case design

The 20 selected receipts are used to build 100 ledger cases:

| Variant | Cases | Injected defect | Expected findings |
| --- | ---: | --- | --- |
| `clean` | 20 | none; CORD values unchanged | none |
| `total_mismatch` | 20 | `total + 100.00`, amount/tax unchanged | INV-003 |
| `missing_total` | 20 | `total` cell emptied | INV-003 (not comparable) |
| `zero_total` | 20 | `total = 0.00`, amount/tax unchanged | INV-003, INV-023 (zero) |
| `negative_total` | 5 | `total = -100.00`, no red-letter marker | INV-003, INV-023 (negative) |
| `missing_tax` | 5 | `tax` cell emptied | INV-003 (not comparable) |
| `missing_original` | 5 | `sourceFile` points to a non-existent file; `sha256` is the real image hash | INV-007, INV-024 |
| `duplicate_probe` | 5 | the clean row is duplicated verbatim in the same file | **unscorable** (see below) |

Clean cases are negatives for every scored rule. A rule is a true positive when a labelled case produces a
finding for that rule, a false positive when an unlabelled case does, and a false negative when a labelled case
does not. Precision = TP/(TP+FP); recall = TP/(TP+FN); case-level. Probe cases are excluded from P/R.

The `missing_original` variant is synthetic; the clean variants use the actual public JPEG. The shipped
`fileLink` implementation verifies `sourceFile` existence for both INV-007 and INV-024, so both are labelled
for that defect. That is the shipped behavior, not a claim that INV-007 is semantically about missing files.

The `duplicate_probe` is intentionally **not** a scored duplicate-key test. CORD supplies no invoice
code/number; the plugin's key becomes `|`, and `uniqueInvoice` silently skips every row. Duplicating a row
therefore cannot be detected by the plugin. The probe documents that coverage gap instead of inventing an
invoice number to make INV-005 pass. There is no future-date probe because CORD has no date at all.

## Rule coverage

| Rule | Field source | Status |
| --- | --- | --- |
| INV-001 | invoiceCode/invoiceNumber/docType | not provided by CORD; excluded |
| INV-002 | issueDate | not provided by CORD; excluded |
| INV-003 | CORD amount/tax/total | **scored** |
| INV-004 | taxRate | not provided by CORD; excluded |
| INV-005 | invoiceCode/invoiceNumber | not provided; duplicate probe is unscorable |
| INV-006 | invoice key/formNo/history | not provided by CORD; excluded |
| INV-007 | image-derived sourceFile/sha256 | **scored** (shipped fileLink also checks existence) |
| INV-008 | isRed/originalInvoiceNumber | not provided by CORD; excluded |
| INV-009 | buyerName/buyerTaxId | not provided by CORD; excluded |
| INV-010 | sellerName/sellerTaxId | not provided by CORD; excluded |
| INV-011 | itemName/taxRate | not provided by CORD; excluded |
| INV-012 | taxRate/免税 status | not provided by CORD; excluded |
| INV-013 | lineAmount/lineTax | not mapped; CORD menu lines are not ledger detail rows |
| INV-014 | quantity/unitPrice/lineAmount | not mapped; line-level fields are not the invoice-row shape |
| INV-015 | seller/buyer/issueYear/invoice number | not provided by CORD; excluded |
| INV-016 | seller/buyer/issueDate | not provided by CORD; excluded |
| INV-017 | issueDate/period/contract | not provided by CORD; excluded |
| INV-018 | issueDate | not provided by CORD; excluded |
| INV-019 | formNo/formAmount | not provided by CORD; excluded |
| INV-020 | invoice key/formNo | not provided by CORD; excluded |
| INV-021 | buyerName/docType | not provided by CORD; excluded |
| INV-022 | buyerTaxId/sellerTaxId | not provided by CORD; excluded |
| INV-023 | CORD total | **scored** (total branch only) |
| INV-024 | image-derived sourceFile | **scored** |
| INV-025 | buyerName/sellerName/invoiceNumber/remark | not provided by CORD; excluded |
| INV-026 | meta-rule | not scored; it reports only unaccounted rules |

`INV-001` still emits `发票号码为空` for every row because the plugin treats an absent invoice number as a
missing field. Those are field-absence findings, not CORD defects; they are excluded from P/R and shown in
`summary.json` under `raw.by_rule`.

The plugin's `executed` counter can count a rule whose loop ran with every required field blank. In this run
`INV-001, INV-002, INV-005, INV-006, INV-009, INV-010, INV-017, INV-020, INV-021, INV-022, INV-025` were
counted as executed despite having no data to measure. Do not read `executed` as coverage; use the
`skipped`/`provided` distinctions in `summary.json`. This is a coverage-accounting observation about the
shipped plugin, not a benchmark failure.

## Result

The recorded run is in [`RESULTS.md`](RESULTS.md) and [`summary.json`](summary.json). In short:

| Rule | Positives | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| INV-003 | 70 | 70 | 0 | 0 | 1.000 | 1.000 |
| INV-007 | 5 | 5 | 0 | 0 | 1.000 | 1.000 |
| INV-023 | 25 | 25 | 0 | 0 | 1.000 | 1.000 |
| INV-024 | 5 | 5 | 0 | 0 | 1.000 | 1.000 |

The duplicate probe detected 0 of 5 duplicate-row cases and is unscorable, not a pass. The raw plugin output
across 100 cases / 105 rows was 210 findings: 85 error, 105 warn, 20 info; 105 of the warnings were the
expected `INV-001` missing-number signal.

Perfect scores here mean the shipped checks detect the injected numeric and file-link defects on these 20
receipts; they do not mean the plugin detects duplicate reimbursement, wrong buyer, future dates, tax-rate
errors or line-item errors on CORD. Those rules had no input and are excluded.

## Limitations

- CORD is an Indonesian receipt corpus. Its totals are not Chinese VAT invoice 价税合计 values; `sub_total`
  may include discounts/service charges. Receipt selection only uses arithmetic-consistent records, and the
  benchmark does not claim semantic equivalence.
- Only 20 of 100 test receipts are used. They are the first receipts satisfying the money-field and
  arithmetic-consistency filter; this is a deterministic sample, not a random or representative one.
- CORD amounts are IDR while the shipped rule pack profile says CNY. The plugin does not read a currency field,
  so only numeric branches are exercised. The large-amount branch (1,000,000) is not tested because it would
  be meaningless for IDR amounts.
- Three-decimal CORD values are rounded to 2 decimals. The selected 20 avoid boundary disagreements, but the
  rounding is still a transformation.
- `sourceFile`/`sha256` are image-derived, and the missing-original variant is synthetic. The duplicate-key
  and future-date rules cannot be scored at all; no invoice numbers or dates were fabricated.
- The benchmark calls the plugin with gold annotations, not OCR output. It does not measure extraction
  accuracy, workbook rendering, markdown wording, or performance beyond a successful tool call.
- The plugin's `executed` counter overstates measured coverage for rules with absent fields; see above.
- The recorded benchmark run used the pre-downloaded seed bundle. The public-mirror download path was
  exercised separately and its SHA-256 hashes matched `data.lock.json`; it was not re-downloaded for every
  evaluation run.

## Citation

If you use this benchmark or the underlying data, cite the CORD paper and follow the CC BY 4.0 attribution:

```bibtex
@inproceedings{park2019cord,
  title     = {CORD: A Consolidated Receipt Dataset for Post-OCR Parsing},
  author    = {Park, Seunghyun and Shin, Seung and Lee, Bado and Lee, Junyeop and Surh, Jaeheung and Seo, Minjoon and Lee, Hwalsuk},
  booktitle = {Document Intelligence Workshop at Neural Information Processing Systems},
  year      = {2019}
}
```
