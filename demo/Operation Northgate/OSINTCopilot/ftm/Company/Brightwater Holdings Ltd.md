---
id: "d3e0a000-0000-4000-8000-000000000004"
type: Company
schemaFamily: ftm
ftmSchema: Company
label: "Brightwater Holdings Ltd"
name: "Brightwater Holdings Ltd"
jurisdiction: "cy"
country: "cy"
registrationNumber: "HE 000000"
incorporationDate: "2024-03-03"
status: "Active"
legalForm: "Private limited company"
sector: "Holding company"
notes: "Owns 60% of Northgate Freight BV since April 2024. Owned in turn by Aurelia Trade LP (Seychelles)."
image: "OSINTCopilot/Evidence/brightwater-holdings-ltd-picture.png"
osint_confidence: conflicted
osint_sources:
  - id: src_670df6244cb8a179
    source_url: http://registry.cy.example/company/HE000000
    archive_status: skipped
    inferred: false
    rationale: Registry extract
    captured_at: 2026-09-18T09:30:00.000Z
    claims:
      - path: properties.country
        value: cy
  - id: src_014cb462f0e3f60d
    source_url: https://pastebin.news.example/raw/brightwater-invoice-0412
    archive_status: skipped
    inferred: false
    rationale: Leaked invoice gives a Maltese address for the same company number
    captured_at: 2026-09-18T09:30:00.000Z
    claims:
      - path: properties.country
        value: mt
osint_contradictions:
  - field_path: properties.country
    entries:
      - source_id: src_670df6244cb8a179
        value: cy
      - source_id: src_014cb462f0e3f60d
        value: mt
---

# Brightwater Holdings Ltd

## Properties

- **Name**: Brightwater Holdings Ltd
- **Jurisdiction**: cy
- **Registration number**: HE 000000
- **Incorporation date**: 2024-03-03
- **Country**: cy
- **Status**: Active
- **Legal form**: Private limited company
- **Sector**: Holding company
- **image**: OSINTCopilot/Evidence/brightwater-holdings-ltd-picture.png

## Relationships

<!-- Add relationships using wikilinks: [[Entity Name]] RELATIONSHIP_TYPE [[Target Entity]] -->
- [[OSINTCopilot/ftm/Person/Marta Koval|Marta Koval]] DIRECTORSHIP [[OSINTCopilot/ftm/Company/Brightwater Holdings Ltd|Brightwater Holdings Ltd]]
- [[OSINTCopilot/ftm/ShellCompany/Aurelia Trade LP|Aurelia Trade LP]] OWNERSHIP [[OSINTCopilot/ftm/Company/Brightwater Holdings Ltd|Brightwater Holdings Ltd]]
- [[OSINTCopilot/ftm/Company/Brightwater Holdings Ltd|Brightwater Holdings Ltd]] OWNERSHIP [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]]
- [[OSINTCopilot/ftm/Company/Brightwater Holdings Ltd|Brightwater Holdings Ltd]] PAYMENT [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]]
- [[OSINTCopilot/ftm/Company/Brightwater Holdings Ltd|Brightwater Holdings Ltd]] UNKNOWNLINK [[OSINTCopilot/ftm/Address/Brightwater registered office|Brightwater registered office]]

## Notes

Owns 60% of Northgate Freight BV since April 2024. Owned in turn by Aurelia Trade LP (Seychelles).
