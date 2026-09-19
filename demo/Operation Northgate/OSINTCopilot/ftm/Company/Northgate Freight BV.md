---
id: "d3e0a000-0000-4000-8000-000000000005"
type: Company
schemaFamily: ftm
ftmSchema: Company
label: "Northgate Freight BV"
name: "Northgate Freight BV"
jurisdiction: "nl"
country: "nl"
registrationNumber: "81234567"
incorporationDate: "2019-06-12"
status: "Active"
legalForm: "Besloten vennootschap"
sector: "Freight forwarding"
website: "https://northgate-freight.example"
image: "OSINTCopilot/Evidence/northgate-freight-bv-picture.png"
osint_confidence: high
osint_sources:
  - id: src_828903f58428e7b2
    source_url: https://kvk-register.example/company/81234567
    archive_status: skipped
    inferred: false
    rationale: Trade register entry
    captured_at: 2026-09-18T09:30:00.000Z
  - id: src_7d3a71da8f1128bf
    source_url: https://news.example/2024/06/21/rotterdam-customs-seize-counterfeit-cancer-drugs
    archive_status: skipped
    inferred: false
    rationale: Named as the forwarder of the seized pallets
    captured_at: 2026-09-18T09:30:00.000Z
  - id: src_bd4ae553d2eb934e
    source_url: https://customs.example/press/2024-06-20-parcel-seizure
    archive_status: skipped
    inferred: false
    rationale: Customs press release names the forwarder
    captured_at: 2026-09-18T09:30:00.000Z
---

# Northgate Freight BV

## Properties

- **Name**: Northgate Freight BV
- **Jurisdiction**: nl
- **Registration number**: 81234567
- **Incorporation date**: 2019-06-12
- **Country**: nl
- **Status**: Active
- **Legal form**: Besloten vennootschap
- **Sector**: Freight forwarding
- **Website**: https://northgate-freight.example
- **image**: OSINTCopilot/Evidence/northgate-freight-bv-picture.png

## Relationships

<!-- Add relationships using wikilinks: [[Entity Name]] RELATIONSHIP_TYPE [[Target Entity]] -->
- [[OSINTCopilot/ftm/Person/Daniel Arendt|Daniel Arendt]] DIRECTORSHIP [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]]
- [[OSINTCopilot/ftm/Company/Brightwater Holdings Ltd|Brightwater Holdings Ltd]] OWNERSHIP [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]]
- [[OSINTCopilot/ftm/Company/Brightwater Holdings Ltd|Brightwater Holdings Ltd]] PAYMENT [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]]
- [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]] UNKNOWNLINK [[OSINTCopilot/ftm/Address/Northgate warehouse, Waalhaven|Northgate warehouse, Waalhaven]]
- [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]] UNKNOWNLINK [[OSINTCopilot/ftm/Vehicle/Delivery van VX-492-K|Delivery van VX-492-K]]
- [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]] UNKNOWNLINK [[OSINTCopilot/ftm/Domain/northgate-freight.example|northgate-freight.example]]
- [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]] PARTICIPATED_IN [[OSINTCopilot/ftm/Event/Rotterdam customs seize 38 parcels|Rotterdam customs seize 38 parcels]]
- [[OSINTCopilot/ftm/Domain/medsupply-direct.example|medsupply-direct.example]] NAMES_AS_SHIPPER [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]]
- [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]] USES_PHONE [[OSINTCopilot/ftm/LegalEntity/+44 20 7946 0958|+44 20 7946 0958]]
- [[OSINTCopilot/user/parcel-batch/Pallet NGF-2260 (38 parcels)|Pallet NGF-2260 (38 parcels)]] SHIPPED-VIA [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]]

## Notes


