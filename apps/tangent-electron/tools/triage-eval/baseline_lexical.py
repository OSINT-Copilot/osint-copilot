#!/usr/bin/env python3
"""
Arm A: the baseline the model has to beat. Token overlap between the page and the case summary.

Deliberately dumb and deliberately cheap: if ~60 lines of this separate the true case from the
decoys as well as a 330 MB transformer does, the transformer has not earned its download.

Usage: python3 baseline_lexical.py cases/crossproduct.jsonl > results/lexical.jsonl
"""
import json, math, re, sys, collections

STOP = set('''the a an and or of to in for on at by with from as is are was were be been being this
that these those it its their his her our your they we you i he she not no but if then than so such
all any each other more most some can could will would shall should may might must have has had do
does did done about into over under after before between during without within across per via'''.split())

def tokens(text: str) -> list[str]:
    # \w keeps non-Latin scripts, unlike the app's own /\b[a-z0-9]{3,}\b/ tokenizer.
    return [t for t in re.findall(r'\w{3,}', text.lower(), re.UNICODE) if t not in STOP]

def score(page_text: str, summary: str) -> float:
    page, case = collections.Counter(tokens(page_text)), set(tokens(summary))
    if not case or not page:
        return 0.0
    # Overlap weighted by how often the shared term appears in the page, damped by log so one
    # repeated word cannot dominate, normalised by the size of the summary's vocabulary.
    hit = sum(1.0 + math.log(page[t]) for t in case if t in page)
    return hit / len(case)

if __name__ == '__main__':
    for line in open(sys.argv[1], encoding='utf8'):
        row = json.loads(line)
        print(json.dumps({**{k: row[k] for k in ('page', 'case', 'label')},
                          'arm': 'lexical', 'score': round(score(row['text'], row['summary']), 4)}))
