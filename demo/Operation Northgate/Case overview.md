# Operation Northgate

A fictional investigation, made to show what OSINT Copilot does. Everything in it is invented, including every name, company, address, domain and wallet.

**The case.** A forum seller, harbor_pharma, sells counterfeit cancer medicines through medsupply-direct.example. The shop names [[OSINTCopilot/ftm/Company/Northgate Freight BV|Northgate Freight BV]] as its shipper. Customs in Rotterdam seized 38 of its parcels in June 2024. Northgate is 60% owned by [[OSINTCopilot/ftm/Company/Brightwater Holdings Ltd|Brightwater Holdings Ltd]], whose director is [[OSINTCopilot/ftm/Person/Marta Koval|Marta Koval]]; Brightwater is owned by [[OSINTCopilot/ftm/ShellCompany/Aurelia Trade LP|Aurelia Trade LP]] in the Seychelles, through a nominee, [[OSINTCopilot/ftm/Person/Jonah Ferris|Jonah Ferris]].

## Where to look
- **Entities** (the graph): people, companies, places, events, and the e-mails, wallets, domains and IP addresses collected with the browser extension. Switch to the *Money trail* graph workspace for the payment side only.
- **Timeline**: from Northgate's incorporation in 2019 to the seizure, and one undated rumour.
- **Locations**: Limassol, Rotterdam, Tallinn and the Seychelles; the Antwerp stash has no coordinates yet ("Geolocate missing").
- **Chat**: four saved conversations. *Map the parcel route* ends with proposed graph changes to apply; *Add a breach lookup* with proposed vault changes (a skill, an enricher, a credentials file and a script diff).
- **Tools & Skills**: three case skills, four enrichers (runnable, keyed, draft) and the *Case memo* task agent, whose output is in OSINTCopilot/custom/outputs/memos.
- **Canvas**: OSINTCopilot/boards/Case board.canvas.
- **Sources**: one note per page the extension sent from, with its highlights and notes. The registry page: [[OSINTCopilot/Sources/brightwater-holdings-ltd-he-412345-company-registry-bbc33d08c675]].
- **Evidence**: page captures (archive, screenshots, page text) and the forwarder's PDF manifest, each with its SHA-256.
- **Browser extension activity** (command palette): everything the extension sent, including one note taken back out with Remove.

## Confidence
Each entity grades itself by its sources: Jonah Ferris is *unverified* (an inference), Marta Koval *low* (one record), Daniel Arendt *medium*, Northgate Freight *high*, and Brightwater *conflicted* (two sources disagree on its country). See `osint_confidence` in each note.
