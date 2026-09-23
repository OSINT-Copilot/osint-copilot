#!/usr/bin/env python3
"""
Arm C: Laya's multilingual checkpoint, one `score` question per item.

`score`, not `noul`: laya issue #185 reports the decision head's output is ~300x the encoder's
scale, which saturates act_probability to 1.0. And the multilingual checkpoint ships
temperature [1.0, 1.0, 1.0] with no temperature_by_options, so every number here is a raw
softmax, not a calibrated probability. We record the probabilities and derive our own ordinal
expectation; nothing downstream may treat these as percentages.

`probabilities` comes back as a dict keyed by level ("0".."3"), and `score` is already the
expectation over it. The router picks a checkpoint by script/language, so `--model` forces the
one we would actually ship; without it an English page is judged by the English checkpoint even
when the default is multilingual.

Usage: python3 run_laya.py cases/crossproduct.jsonl results/laya.jsonl [--model multilingual]
"""
import json, sys, time, pathlib

QUESTION_VERSION = 1
CRITERIA = [
    'nothing to do with this investigation',
    'same general subject, but names no person, company, place or identifier from it',
    'mentions something or someone named in the investigation',
    'states a fact about someone or something named in the investigation',
]

def instructions(summary: str) -> str:
    return ('How much does the page content bear on the investigation described here? '
            f'Investigation: {summary}')

def main(src: str, dst: str, forced: str | None) -> None:
    from laya import Router
    router = Router(default='multilingual', max_loaded=1)
    rows = [json.loads(line) for line in open(src, encoding='utf8')]
    out = []
    for i, row in enumerate(rows, 1):
        questions = {'relevance': {'type': 'score',
                                   'instructions': instructions(row['summary']),
                                   'criteria': CRITERIA}}
        started = time.perf_counter()
        result = router.predict(row['text'], questions, model=forced)
        ms = round((time.perf_counter() - started) * 1000, 1)
        answer = result['answers']['relevance']
        probs = {k: round(float(v), 5) for k, v in (answer.get('probabilities') or {}).items()}
        routed = (result.get('routing') or {}).get('model')
        out.append({**{k: row[k] for k in ('page', 'case', 'label')}, 'arm': f'laya-{routed}',
                    'questionVersion': QUESTION_VERSION, 'score': answer.get('score'),
                    'probabilities': probs, 'confidence': answer.get('confidence'),
                    'act_probability': (answer.get('action') or {}).get('act_probability'),
                    'routed': routed, 'ms': ms})
        print(f'  {i}/{len(rows)} {row["page"][:28]:28} {row["case"]:20} '
              f'score={answer.get("score")} conf={answer.get("confidence")} [{routed}] {ms}ms', flush=True)
    pathlib.Path(dst).write_text('\n'.join(json.dumps(r) for r in out) + '\n', encoding='utf8')
    print(f'wrote {dst}')

if __name__ == '__main__':
    forced = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else None
    main(sys.argv[1], sys.argv[2], forced)
