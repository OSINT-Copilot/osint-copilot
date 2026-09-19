---
id: "7f267867-e0de-48f5-bfae-98f2cf4fdfac"
type: campaign
schemaFamily: stix2
label: "Counterfeit oncology shop"
name: "Counterfeit oncology shop"
description: "Sells counterfeit cancer medicines through a forum and a clearnet shop, shipped from Rotterdam."
osint_confidence: low
osint_sources:
  - id: src_3794eaf19f42243a
    source_url: http://harbourmarket.example/thread/4471
    archive_status: skipped
    inferred: false
    rationale: Case analysis
    captured_at: 2026-09-18T09:30:00.000Z
---

# Counterfeit oncology shop

## Properties

- **Name**: Counterfeit oncology shop
- **Description**: Sells counterfeit cancer medicines through a forum and a clearnet shop, shipped from Rotterdam.

## Relationships

<!-- Add relationships using wikilinks: [[Entity Name]] RELATIONSHIP_TYPE [[Target Entity]] -->
- [[OSINTCopilot/stix2/indicator/Checkout error page leaks its upstream|Checkout error page leaks its upstream]] INDICATES [[OSINTCopilot/stix2/campaign/Counterfeit oncology shop|Counterfeit oncology shop]]
- [[OSINTCopilot/stix2/campaign/Counterfeit oncology shop|Counterfeit oncology shop]] USES [[OSINTCopilot/mitre/attack-pattern/Acquire Infrastructure- Domains|Acquire Infrastructure: Domains]]
- [[OSINTCopilot/stix2/campaign/Counterfeit oncology shop|Counterfeit oncology shop]] RELATED-TO [[OSINTCopilot/ftm/Domain/medsupply-direct.example|medsupply-direct.example]]

## Notes


