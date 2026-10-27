#!/usr/bin/env python3
"""
Builds the cross-product slice: every demo page scored against every case summary.

The point is not accuracy. It is whether the score MOVES when the case changes while the page
stays the same. A model that scores "is this page suspicious" rather than "is this page about
THIS case" passes every other test and fails this one, which is the only thing triage needs.

Labels are by construction: the Northgate summary is the case these pages were captured for;
the other five are real investigations of comparable specificity that these pages have nothing
to do with. Run from this folder: python3 build_crossproduct.py
"""
import json, pathlib

DEMO = pathlib.Path(__file__).resolve().parents[4] / 'demo' / 'Operation Northgate' / 'OSINTCopilot' / 'Evidence'

SUMMARIES = {
    'northgate': (
        'Counterfeit oncology medicines sold online without prescription and shipped through a '
        'Rotterdam freight forwarder. Interested in the shell companies that own the forwarder, '
        'their directors and nominee shareholders, and the crypto payment routes used by the seller.'
    ),
    'maritime-insurance': (
        'Insurance fraud in maritime cargo: vessels reporting false cargo losses in the '
        'Mediterranean, the brokers underwriting the policies, and the surveyors signing the claims.'
    ),
    'recruitment-scam': (
        'A recruitment scam targeting software engineers in Bangalore: fake job offers, upfront '
        'training fees, and the shell consultancies collecting the payments.'
    ),
    'sanctions-evasion': (
        'Evasion of Baltic sanctions through ship-to-ship transfers of crude oil, the flag '
        'registries involved, and the trading houses arranging the cargoes.'
    ),
    'wildlife-trade': (
        'Illegal wildlife trade in protected reptiles shipped as aquarium supplies from Southeast '
        'Asia, the export permits used, and the courier companies moving the consignments.'
    ),
    'bank-phishing': (
        'A phishing campaign against retail bank customers in Spain: lookalike domains, spoofed SMS '
        'sender identities, and the money mules receiving the transfers.'
    ),
}

rows = []
for path in sorted(DEMO.glob('*.md')):
    text = path.read_text(encoding='utf8').strip()
    if len(text) < 50:
        continue  # the PDF's text note is empty; nothing to judge
    for key, summary in SUMMARIES.items():
        rows.append({
            'page': path.stem,
            'case': key,
            'summary': summary,
            'text': text,
            'label': 1 if key == 'northgate' else 0,
        })

out = pathlib.Path(__file__).parent / 'cases' / 'crossproduct.jsonl'
out.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n', encoding='utf8')
print(f'{len(rows)} pairs, {len({r["page"] for r in rows})} pages x {len(SUMMARIES)} summaries -> {out}')
