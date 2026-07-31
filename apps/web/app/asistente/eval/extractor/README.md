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
| `.local/extractor-golden/` | Private captures + their expected JSON (gitignored, **none declared today**) |

Every fixture the manifest declares is a file this repo ships, so a full run needs
nothing but the API key. `--only` takes the **id** (second column), not the scenario:

| Scenario | Fixture id | Storage |
|---|---|---|
| `desktop` | `synthetic-baseline` | committed |
| `payment-screen` | `synthetic-payment-screen` | committed, **negative** (#1247) |
| `value-only-composition` | `synthetic-value-only-composition` | committed (#1345) |
| `amortization-schedule-screenshot` | `synthetic-amortization-schedule` | committed, balance-series track |

Those four captures are the whole runnable set, which is what makes "the extractor
evals do not regress" verifiable without private data.

`synthetic-value-only-composition` is the one added by **#1345**, and it earns its place
by having been red on the code that shipped before it: a bank's «Composición» tab, seven
funds printing a name and a value in euros and nothing else, two names cut off with «…».
It grades the value-only row of #1325 *and* the schema-complexity pathology of #1345 —
the reading came back with the right `documentType`, the right total and an empty
`positions` array, 3/3 runs at `temperature: 0`. That is why the fix had to reach the
schema and not the prompt, and why a synthetic render is enough here even though the
failure was found on a real capture: what fails is not the pixels.

### Uncovered scenarios (#1254)

The manifest used to declare nine more fixtures under `.local/extractor-golden/` — a
directory that existed in no checkout, in the main repo or in any worktree. The
consequences were not cosmetic: every full run came back `incomplete` / `REJECTED`
with exit 1 over absent files, which is permanent noise rather than signal; the merge
gate #1243 wrote («a human run of the complete set») could not be executed by anyone,
not for lack of access but because there was nothing to run; and the set read as six
graded image scenarios when there was one. They were retired rather than left in
place, and the scenarios they were meant to cover stay in `manifest.ts`'s catalog with
what a real capture would buy:

| Scenario | What a capture must show | Track |
|---|---|---|
| `mobile` | a phone screenshot: narrow column, cropped figures, system chrome | image |
| `reflections` | a photo of a screen — glare, moiré, partial glare over a figure | image |
| `misaligned-columns` | a broker table whose columns do not line up under their headers | image |
| `ticker-name-ambiguity` | a row where the instrument name reads like another ticker | image |
| `thousand-separator` | both conventions in one capture (`1.000` vs `1,000`) | image |
| `debt-statement` | a real bank debt statement with dated balances | PDF |
| `amortization-schedule` | a real amortization schedule (only observed balances graded) | PDF |
| `portfolio-snapshot` | a real portfolio export, holdings only | XLSX/CSV |
| `portfolio-with-movements` | the same plus a movements sheet | XLSX |

These are worth having — real degradations are exactly where one vision model differs
from another, and a synthetic render is cleaner than life. But a fixture is a file,
never a line in an array: **add the capture first, then the manifest entry**. A
manifest test fails the moment a non-committed fixture is declared, so the README
table above and the declaration move together.

Two of the nine need no private data at all and are the cheapest to close: the
spreadsheet track is deterministic (no API key), so a safe synthetic workbook would
grade it inside CI, exactly as the synthetic PNGs do for the vision tracks.

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

  It stays negative after **#1244** as well, and that slice makes it a much sharper
  test than it used to be. #1244 added `holding_event`, whose shape is *exactly* a
  payment screen — so this capture now sits one step from being extractable, and is
  not. The reason is precise: the only date on it belongs to «Próxima cuota», never to
  the payment itself, and a `holding_event` requires the fact's **own** day. The way to
  fail this fixture is therefore the most dangerous invention the new document can
  make — borrowing the next installment's date for the payment — and the extractor
  prompt forbids it in as many words. A red run names the document that came back, so
  it says which lane did the inventing.

  Note it can now go green two ways — the model answers `none`, or it tries and the
  seam declines the reading downstream. Both are correct outcomes, but a green run no
  longer tells you which happened; only a red one is precise, and it names the document
  that came back.

  **`holding_event` has no positive fixture yet**, and that gap is deliberate rather
  than forgotten. #1254's rule is *add the capture first, then the fixture entry*, and
  the asymmetry with the negative above is the reason a synthetic render will not do:
  a negative is falsifiable by *any* recognition, so a clean render still tests
  something real, whereas a positive pins figures that a render supplies trivially —
  it would grade the render, not the reading ("más limpio que la vida", #1247). The
  real positive for this document is the manual validation session that gates PRD
  #1241.

  What the shipped set *does* already guard is the reclassification risk this document
  introduces: `synthetic-amortization-schedule` is a **positive `balance_series`**
  fixture, so a debt capture drifting into the new lane shows up as a red run there.

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

The XLSX/CSV **positions + movements** track (`positions_movements` document, PRD
#1103 S4) is **deterministic** — it needs no API key — and declares no fixture today.
Its grader is still covered in CI by `graders.test.ts`; what is missing is an
end-to-end reading of a book. Its expected JSON grades each holding's `fidelity` tier
(`movements` / `declared_cost` / `value_only`) and the movement count:

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
crossing: no fixture reads positions out of a PDF. The debt document does cross formats
(the committed screenshot grades `balance_series` from an image); positions crosses in
code and in unit tests only. This harness is still owed a fixture for it — ideally a
committed synthetic one, since a rendered portfolio PDF needs no real data.

## Add a private fixture

None are declared today (#1254). To cover one of the private scenarios above, put the
file on disk **before** declaring it in `manifest.ts`.

Create the local directory:

```bash
mkdir -p .local/extractor-golden
```

Then add, for the scenario you are covering:

- `<id>.png` (or the `.pdf` / `.xlsx` the manifest entry will name)
- `<id>.expected.json` with the ground-truth extraction

…and only then the manifest entry, plus its row in the table above. `run.ts` skips a
declared fixture whose files are absent and the run exits non-zero as **incomplete**,
which is right for a capture that exists on the reviewer's machine and wrong for one
that exists nowhere.

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

- `mustBeUncertain` — the gate fails unless those rows arrive with
  `uncertain: true`. A row is named by its ticker or, on a screen that prints
  none (a value-only composition tab), by its name.
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

That is the **full gate**: since #1254 every declared fixture is committed, so the run
above is complete and can come back green with nothing but the API key. It spans all
three verdicts on purpose — two positive positions readings (one of them value-only), a
positive balance-series reading and a negative case — which is the combination that
makes a green run mean something (see the tripwire note above).

Run a subset while iterating (the JSON report includes `"subset": true`; do not
treat that verdict as a model admission):

```bash
bun run eval:extractor -- --only synthetic-baseline synthetic-payment-screen
```

If you declare a private fixture, its absence makes the run **incomplete** and exits
non-zero — by design, and the reason the phantom entries had to go.

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
- `skipped` count for declared fixtures whose files are absent (zero today);
- `subset: true` when `--only` narrowed the fixture list (admit verdict not valid
  for model admission).

Default threshold is **100%** — every attempted check must pass. A declared fixture
whose file is missing marks the run incomplete and exits non-zero even if every
committed capture passes.

## Reviewing a model change

1. Set `WORTHLINE_EXTRACTOR_MODEL` (or pass `--model`) to the candidate.
2. Run `bun run eval:extractor` and archive the JSON report with the change.
3. Only merge a model bump when the report is complete and `ADMITTED`.

The gate is runnable by anyone with the API key. What it does NOT cover is the list of
uncovered scenarios above — read a green run as "the three committed captures did not
regress", not as "the extractor handles a photographed screen".

Pure grading logic is covered in CI via `graders.test.ts`; no live vision calls.
`manifest.test.ts` also checks in CI that every committed PNG and expected file is
readable and parses, and `run.test.ts` that fixture selection knows the new ids — so
the negative-case guarantee (hallucinates → fails, `unrecognized` → passes) lives in
the normal test suite, key or no key.
