---
skill_kind: vault
id: company_ownership_trace
name: "Company ownership trace"
description: "Walk registry records from a company to its ultimate owner"
---

1. Start from the operating company's registry extract: directors, shareholders, registered office.
2. For each corporate shareholder, repeat in its own jurisdiction until you reach a person or a dead end.
3. Mark nominee directors and registered agents as such; they are not owners.
4. Record each hop as an Ownership or Directorship connection, with the registry page as its source.
5. Finish with the chain, the jurisdictions it crosses, and where the records stop.
