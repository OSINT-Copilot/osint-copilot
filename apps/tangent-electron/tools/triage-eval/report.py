#!/usr/bin/env python3
"""
Compares arms on the cross-product slice.

The headline is rank-1 accuracy: for each page, is the case it was actually captured for ranked
above all five decoys? It is scale-free, so a 0-3 ordinal and an unbounded overlap count can be
put side by side. Random is 1/6. Separation (true minus best decoy) says by how much, in the
arm's own units, and a negative worst-case means some page ranked a decoy first.

Usage: python3 report.py results/*.jsonl
"""
import json, sys, collections, statistics

def load(path):
    rows = [json.loads(l) for l in open(path, encoding='utf8')]
    for r in rows:
        r['value'] = r.get('expected') if r.get('expected') is not None else r['score']
    return rows

print(f'{"arm":12} {"rank-1":>8} {"true":>7} {"best decoy":>11} {"margin":>8} {"worst":>8}')
print('-' * 58)
for path in sys.argv[1:]:
    rows = load(path)
    if not rows:
        continue
    arm = rows[0].get('arm', path)
    by_page = collections.defaultdict(dict)
    for r in rows:
        by_page[r['page']][r['case']] = r['value']
    firsts, trues, decoys, margins = 0, [], [], []
    for page, scores in by_page.items():
        true = scores['northgate']
        best_decoy = max(v for k, v in scores.items() if k != 'northgate')
        firsts += 1 if true > best_decoy else 0
        trues.append(true); decoys.append(best_decoy); margins.append(true - best_decoy)
    print(f'{arm:12} {firsts}/{len(by_page):<6} {statistics.mean(trues):7.3f} '
          f'{statistics.mean(decoys):11.3f} {statistics.mean(margins):8.3f} {min(margins):8.3f}')
