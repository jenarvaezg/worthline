# Vision extractor golden set (#991)

Local admission gate for `WORTHLINE_EXTRACTOR_MODEL`. The runner calls the same
production seams — `extractDocumentFromVisionAttachment` for screenshots *and* PDFs
(since #1243 one seam identifies the document by its content, not by the file kind)
and the deterministic spreadsheet extractor — compares the validated JSON against
expected fixtures, and emits a machine-readable admit/reject report.

This harness stays **outside CI**. Normal `bun run test` never needs
`GOOGLE_GENERATIVE_AI_API_KEY` or private captures.

## Fixture layout

| Location | What lives there |
|---|---|
| `apps/web/app/asistente/eval/extractor/fixtures/` | Safe synthetic captures committed to git |
| `apps/web/app/asistente/eval/extractor/expected/` | Expected JSON for committed fixtures |
| `.local/extractor-golden/` | Private broker captures + their expected JSON (gitignored) |

The manifest in `manifest.ts` covers every required scenario. `--only` takes the **id**
(second column), not the scenario:

| Scenario | Fixture id | Storage |
|---|---|---|
| `desktop` | `synthetic-baseline` | committed |
| `payment-screen` | `synthetic-payment-screen` | committed, **negative** (#1247) |
| `mobile` | `mobile` | private |
| `reflections` | `reflections` | private |
| `misaligned-columns` | `misaligned-columns` | private |
| `ticker-name-ambiguity` | `ticker-name-ambiguity` | private |
| `thousand-separator` | `thousand-separator` | private (`1.000` vs `1,000`) |

Plus one committed capture on the balance-series track below
(`synthetic-amortization-schedule`, scenario `amortization-schedule-screenshot`). The
three committed captures make the vision tracks runnable with nothing but the API
key — no `.local/extractor-golden/` needed — which is what makes "the extractor evals
do not regress" verifiable without private data.

### Negative cases (#1247)

A negative fixture asserts the failure that matters most to #1241: **the model must
not hallucinate `positions` on a screen that is not a portfolio**. Its expected file
declares the absence of an extraction explicitly:

```json
{ "expect": "unrecognized" }
```

This is a closed shape of its own, not a relaxed positive one — `parseGoldenExpected`
takes a union, so a positive expected with an empty or missing `positions` array is a
parse error instead of silently grading as a negative case.

The grader collapses to a single check, `no alucina posiciones`:

- **passes** when the extractor answers `status: "unrecognized"`;
- **fails** for anything else, and the check name says what came back instead —
  including the hallucinated tickers (`no alucina posiciones — inventó 2 posiciones:
  VWCE ×120, SXR8 ×18`), because that is the actionable part.

One committed capture is a negative case today:

- `synthetic-payment-screen` — an invented bank "payment details" screen for an early
  loan repayment (the shape of capture that originated PRD #1241): amount paid now,
  next installment with its date, and a note that the final installment shrinks. It is
  neither a portfolio nor a series of dated balances, so it is none of the documents the
  seam knows how to extract — it stays negative after #1243.

`synthetic-amortization-schedule` **was** the second negative case, for the narrow reason
that the image seam only knew how to ask for `positions`. #1243 removed that reason, so
the capture was **re-pointed at the balance-series track** with a real dated-balance
expected (six installments from 05/02/2026, balance 11.729,52 → 10.362,84 €) instead of
having its expectation relaxed. `manifest.test.ts` pins that: the fixture must live on the
balance-series track, its expected must parse as a real series, and it must *not* parse as
the negative shape.

**A run of negatives alone proves nothing.** `unrecognized` is also what a blank,
black or truncated capture produces, and it is what a broken API key eventually looks
like too, so a green negative only means something next to a green positive in the
same run — always include `synthetic-baseline` (the subset recipe below does). Two
tripwires back that up in CI: `manifest.test.ts` pins each committed PNG to the exact
size and a minimum weight declared in `synthetic-fixtures.ts`, and a fixture that
errors now contributes a **failing** check instead of no checks, so a broken expected
file can no longer disappear from the ratio and leave the run ADMITTED.

The **dated balance series** track (`balance_series` document, PRD #1048 S4) lives
alongside it. Real statements and amortization schedules are never committed; the
synthetic render is, because since #1243 the same document can arrive as an image:

- `synthetic-amortization-schedule` — committed PNG (`fixtures/`), scenario
  `amortization-schedule-screenshot`: the same debt document arriving as a screenshot
  instead of a PDF, which is the crossing #1243 exists to make work
- `debt-statement` — private PDF (`.local/extractor-golden/debt-statement.pdf`)
- `amortization-schedule` — private PDF (only observed balances are graded, never
  inferred loan parameters)

The XLSX/CSV **positions + movements** track (`positions_movements` document, PRD
#1103 S4) is **deterministic** — it needs no API key — but its documents are a real
portfolio export, so it stays private and outside CI like the others:

- `portfolio-snapshot` — private XLSX (holdings only; graded on the honest
  `value_only` / `declared_cost` fidelity tiers)
- `portfolio-with-movements` — private XLSX (holdings + a movements sheet; the linked
  holdings must reach the `movements` tier)

Its expected JSON grades each holding's `fidelity` tier and the movement count:

```json
{
  "holdings": [
    {
      "name": "Vanguard FTSE All-World",
      "type": "Fondo indexado",
      "isin": "IE00B3RBWM25",
      "value": 1234.56,
      "currency": "EUR",
      "fidelity": "movements"
    }
  ],
  "movementCount": 1,
  "warningIncludes": ["isin"]
}
```

### Known gap: no positions-PDF fixture

Decision 9 of the #1241 grilling lifts ADR 0063's exclusion of **positions inside a
PDF**, and #1243 shipped that path — but the golden set still does not cover the
crossing: every PDF fixture grades the `balance_series` document, and every positions
fixture is an image or a spreadsheet. The debt document now crosses formats in both
directions (private PDFs plus the committed screenshot); positions crosses in code and in
unit tests only. This harness is still owed a fixture for it — ideally a committed
synthetic one, since a rendered portfolio PDF needs no real data.

## Prepare private fixtures

Create the local directory:

```bash
mkdir -p .local/extractor-golden
```

For each private case listed in `manifest.ts`, add:

- `<id>.png` (or the filename named in the manifest)
- `<id>.expected.json` with the ground-truth extraction

Expected JSON uses the same positions contract as production, plus optional
grading hints:

```json
{
  "positions": [
    {
      "ticker": "TSLA",
      "name": "Tesla Inc.",
      "units": 4,
      "marketValueEur": 875.25,
      "currency": "USD",
      "uncertain": true
    }
  ],
  "totalEur": 875.25,
  "warnings": ["La divisa original no se distingue con claridad."],
  "mustBeUncertain": ["TSLA"],
  "warningIncludes": ["divisa"]
}
```

- `mustBeUncertain` — the gate fails unless those tickers arrive with
  `uncertain: true`.
- `warningIncludes` — each fragment must appear in at least one warning
  (case- and accent-insensitive).

Balance-series fixtures use the parallel dated-balance shape:

```json
{
  "balances": [
    { "date": "2026-06-30", "amount": 5592, "currency": "EUR" },
    { "date": "2026-07-31", "amount": 5401.12, "currency": "EUR", "uncertain": true }
  ],
  "warnings": ["Una fila del cuadro estaba tapada."],
  "mustBeUncertain": ["2026-07-31"],
  "warningIncludes": ["tapada"]
}
```

Here `mustBeUncertain` lists ISO dates instead of tickers; `date`, `amount` and
`currency` must all match (amounts within the money epsilon).

Never commit real broker screenshots, bank PDFs or sensitive expected JSON.

Regenerate the committed synthetic PNGs after editing their HTML sources in
`fixtures/` (all of them, or a subset by id):

```bash
bun scripts/generate-extractor-synthetic-fixture.ts
bun scripts/generate-extractor-synthetic-fixture.ts synthetic-payment-screen
```

Every committed fixture is a rendered HTML file in `fixtures/`, so it carries no real
entity, no real brand and no real figure. Add a new one by writing
`fixtures/<id>.html` with a `.frame` root element, then registering it twice:

- its **render viewport** in that generator script;
- its resulting **capture size** in `synthetic-fixtures.ts`, which is what
  `manifest.test.ts` pins the committed PNG against.

Editing an HTML source usually changes the capture size, so the `capture` numbers have
to move with it — that failure in CI is the point: a resized or blanked fixture becomes
a decision, not a silent drift. Finally add the manifest entry and its
`expected/<id>.json`.

## Run the gate

From the repo root (loads `apps/web/.env.local` when present):

```bash
bun run eval:extractor -- --output /tmp/extractor-admission.json
```

Override the candidate model explicitly:

```bash
bun run eval:extractor -- \
  --model gemini-3.5-flash \
  --output /tmp/extractor-gemini-35.json
```

Run a subset while iterating (the JSON report includes `"subset": true`; do not
treat that verdict as a full admission gate):

```bash
bun run eval:extractor -- --only synthetic-baseline mobile
```

Without `.local/extractor-golden/`, the private cases are skipped and the run exits
non-zero as **incomplete** — by design. To exercise only what git ships (the useful
loop while working on the seam, e.g. #1243), ask for the committed subset:

```bash
bun run eval:extractor -- --only \
  synthetic-baseline synthetic-payment-screen synthetic-amortization-schedule
```

That subset spans all three verdicts on purpose: a positive positions reading, a positive
balance-series reading and a negative case — the combination that makes a green run mean
something (see the tripwire note above).

That is a `subset` verdict, not a model admission: the full gate still needs a human
pass over the private captures.

Credential: `GOOGLE_GENERATIVE_AI_API_KEY`. Model selection follows production:
`WORTHLINE_EXTRACTOR_MODEL` from the environment, overridable with `--model`.

The runner waits 20 seconds between fixtures to protect the Google free tier.

## Output and decision

Human progress and the per-fixture table go to stderr. A stable JSON report goes
to stdout and, when `--output` is supplied, to that file. It contains:

- schema version, provider (`google`), model, timestamps;
- one result per fixture with status (`completed`, `skipped`, `error`), checks,
  and paths;
- whole-run passed/total counts, ratio, threshold and admission decision;
- `skipped` count for missing private fixtures;
- `subset: true` when `--only` narrowed the fixture list (admit verdict not valid
  for model admission).

Default threshold is **100%** — every attempted check must pass. Missing private
fixtures mark the run incomplete and exit non-zero even if the committed
synthetic case passes.

## Reviewing a model change

1. Set `WORTHLINE_EXTRACTOR_MODEL` (or pass `--model`) to the candidate.
2. Ensure every private fixture exists under `.local/extractor-golden/`.
3. Run `bun run eval:extractor` and archive the JSON report with the change.
4. Only merge a model bump when the report is complete and `ADMITTED`.

Pure grading logic is covered in CI via `graders.test.ts`; no live vision calls.
`manifest.test.ts` also checks in CI that every committed PNG and expected file is
readable and parses, and `run.test.ts` that fixture selection knows the new ids — so
the negative-case guarantee (hallucinates → fails, `unrecognized` → passes) lives in
the normal test suite, key or no key.
