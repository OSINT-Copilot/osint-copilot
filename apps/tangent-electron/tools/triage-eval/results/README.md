# Cross-product diagnostic — first result (2026-09-23)

Four demo pages, each scored against six case summaries: the investigation they were actually
captured for, and five decoys of comparable specificity. Labels are by construction. The question
is not "is this accurate" but **does the score move when the case changes while the page stays the
same** — a model that scores "is this page suspicious" instead of "is this page about *this* case"
fails here and nowhere else.

Rank-1 = for how many pages the true case outranked all five decoys. Random is 1/6. Margin is in
each arm's own units; "worst" is the worst page, so a negative worst means a decoy won outright.

| arm | rank-1 | mean true | mean best decoy | margin | worst |
|---|---|---|---|---|---|
| lexical baseline (~60 lines) | 3/4 | 0.161 | 0.086 | +0.075 | −0.074 |
| laya, English checkpoint (routed) | **4/4** | 1.310 | 1.079 | +0.230 | +0.167 |
| laya, multilingual checkpoint (forced) | **1/4** | 1.112 | 1.231 | **−0.119** | −0.266 |

## What this says

- **The multilingual checkpoint does not separate cases on English text.** It is worse than the
  lexical baseline and worse than chance on this slice: on average the true case scored *below*
  the best decoy. The plan was built on bundling this checkpoint (~330 MB int8). On this evidence
  that is the wrong model to bundle.
- **The English checkpoint does separate**, and beats the baseline on every page (4/4 vs 3/4, and
  its worst page still has a positive margin where the baseline's goes negative). It is
  ModernBERT-large, 421M, ~808 MB in bf16 — a bigger bundle than planned.
- **The router chooses by script and language**, so `default='multilingual'` did not prevent
  English pages going to the English checkpoint. Shipping one checkpoint means overriding the
  router and accepting whatever that checkpoint does on every language.
- **Confidence is near zero throughout** (0.02–0.12 on the English arm, distributions close to
  uniform), and `act_probability` is 1.0 for every item, which is laya issue #185 reproduced. The
  ordering carries signal; the magnitudes do not. A sort is defensible, a threshold is not.
- **Latency, CPU, fp32 torch**: cold start ~60 s; then median 649 ms (English, 421M) and 249 ms
  (multilingual, 322M) per item, max ~1.2 s on the longest page.

## What this does not say

24 pairs from 4 pages is a diagnostic, not a verdict. Every page is English, fictional, and short.
It cannot tell us whether the multilingual checkpoint works on the text it is meant for — that
needs the non-English slice, and it is the next thing to measure, because the multilingual promise
is the whole reason this was attractive for OSINT.

## Reproduce

```sh
python3 build_crossproduct.py
python3 baseline_lexical.py cases/crossproduct.jsonl > results/lexical.jsonl
~/.cache/osint-triage/venv/bin/python run_laya.py cases/crossproduct.jsonl results/laya-routed.jsonl
~/.cache/osint-triage/venv/bin/python run_laya.py cases/crossproduct.jsonl results/laya-multilingual.jsonl --model multilingual
python3 report.py results/lexical.jsonl results/laya-routed.jsonl results/laya-multilingual.jsonl
```
