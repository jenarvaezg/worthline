# Vision extractor golden set (#991)

Local admission gate for `WORTHLINE_EXTRACTOR_MODEL`. The runner calls the same
`extractPositionsFromImage` seam used in production, compares the validated JSON
against expected fixtures, and emits a machine-readable admit/reject report.

This harness stays **outside CI**. Normal `bun run test` never needs
`GOOGLE_GENERATIVE_AI_API_KEY` or private captures.

## Fixture layout

| Location | What lives there |
|---|---|
| `apps/web/app/asistente/eval/extractor/fixtures/` | Safe synthetic captures committed to git |
| `apps/web/app/asistente/eval/extractor/expected/` | Expected JSON for committed fixtures |
| `.local/extractor-golden/` | Private broker captures + their expected JSON (gitignored) |

The manifest in `manifest.ts` covers every required scenario:

- `desktop` — committed synthetic baseline
- `mobile` — private capture
- `reflections` — private capture
- `misaligned-columns` — private capture
- `ticker-name-ambiguity` — private capture
- `thousand-separator` — private capture (`1.000` vs `1,000`)

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

Never commit real broker screenshots or sensitive expected JSON.

Regenerate the committed synthetic baseline after editing
`fixtures/synthetic-baseline.html`:

```bash
bun scripts/generate-extractor-synthetic-fixture.ts
```

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
