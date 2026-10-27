---
agent_kind: task
id: case-memo
name: Case memo
description: A one-page memo on the state of the case, for the team lead
output_schema: vault_files_v1
output_roots: OSINTCopilot/custom/outputs/memos/
context_roots: OSINTCopilot/ftm/, OSINTCopilot/Sources/, Case overview.md
max_notes: 25
max_context_chars: 80000
enabled_default: true
---

Write one memo as a single file at OSINTCopilot/custom/outputs/memos/<YYYY-MM-DD>-case-memo.md
(the full vault path). Sections: Summary (five lines), Chain of ownership, Money, Shipping, Open
questions. Grade every claim by its sources, per the case rules, and link the notes you used.
