---
id: "2d8ae4a3-7d7f-499d-ac0f-230604542993"
type: indicator
schemaFamily: stix2
label: "Checkout error page leaks its upstream"
name: "Checkout error page leaks its upstream"
pattern: "[url:value MATCHES '/checkout' AND network-traffic:dst_ref.value = '203.0.113.47']"
description: "The shop's checkout error names its upstream host."
osint_confidence: low
osint_sources:
  - id: src_3794eaf19f42243a
    source_url: http://harbourmarket.example/thread/4471
    archive_status: skipped
    inferred: false
    rationale: Case analysis
    captured_at: 2026-09-18T09:30:00.000Z
---

# Checkout error page leaks its upstream

## Properties

- **Name**: Checkout error page leaks its upstream
- **Pattern**: [url:value MATCHES '/checkout' AND network-traffic:dst_ref.value = '203.0.113.47']
- **Description**: The shop's checkout error names its upstream host.

## Relationships

<!-- Add relationships using wikilinks: [[Entity Name]] RELATIONSHIP_TYPE [[Target Entity]] -->
- [[OSINTCopilot/stix2/indicator/Checkout error page leaks its upstream|Checkout error page leaks its upstream]] INDICATES [[OSINTCopilot/stix2/campaign/Counterfeit oncology shop|Counterfeit oncology shop]]

## Notes


