/**
 * The demo investigation's content: a fictional case, its web pages, and the files an
 * investigator would have set up. make-demo.demo.ts turns it into a workspace by driving
 * the real app and the real browser extension.
 *
 * Everything here is invented. Domains use the reserved .example top-level domain, IP
 * addresses the documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24,
 * 2001:db8::/32), the phone number Ofcom's range for drama, and the wallets the worked
 * examples of their own specifications (BIP-173, EIP-55). No person or company named here
 * exists; any resemblance is accidental.
 */

export const CASE_NAME = 'Operation Northgate'

/** Stable entity ids (lowercase v4 UUIDs), so notes, links and boards can name them. */
export function demoId(n: number): string {
	return `d3e0a000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** When the case's material was collected: the sources say so. */
export const CAPTURED = '2026-09-18T09:30:00.000Z'

export type SourceInput = {
	source_url?: string
	inferred: boolean
	rationale: string
	captured_at: string
	archive_status?: 'skipped'
	claims?: { path: string, value: string }[]
}

/**
 * A source for a fictional page. Wayback is skipped: the pages do not exist, and a lookup
 * would only tell archive.org about them.
 */
function source(url: string, rationale: string, claims?: SourceInput['claims']): SourceInput {
	return { source_url: url, inferred: false, rationale, captured_at: CAPTURED, archive_status: 'skipped', ...(claims ? { claims } : {}) }
}

// ------------------------------------------------------------------ the fictional web

export const HOSTS = {
	forum: 'harbourmarket.example',
	shop: 'medsupply-direct.example',
	registry: 'registry.cy.example',
	northgate: 'northgate-freight.example',
	files: 'files.northgate-freight.example',
	kvk: 'kvk-register.example',
	news: 'news.example',
	customs: 'customs.example',
} as const

export const URLS = {
	forumThread: `http://${HOSTS.forum}/thread/4471`,
	shop: `http://${HOSTS.shop}/`,
	shopCheckout: `http://${HOSTS.shop}/checkout`,
	registry: `http://${HOSTS.registry}/company/HE412345`,
	northgateContact: `http://${HOSTS.northgate}/contact`,
	manifestPdf: `http://${HOSTS.files}/reports/q2-2024-consolidation.pdf`,
	kvk: `https://${HOSTS.kvk}/company/81234567`,
	news: `https://${HOSTS.news}/2024/06/21/rotterdam-customs-seize-counterfeit-cancer-drugs`,
	customs: `https://${HOSTS.customs}/press/2024-06-20-parcel-seizure`,
	leakedInvoice: `https://pastebin.${HOSTS.news}/raw/brightwater-invoice-0412`,
	agentList: `https://corpserve-seychelles.example/nominees`,
}

/** Values the extension sends. The chain values are their specifications' worked examples. */
export const VALUES = {
	sellerUsername: '@harbor_pharma',
	btc: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
	eth: '0x52908400098527886E0F7030069857D2E4169EE7',
	ipv4: '203.0.113.47',
	ipv6: '2001:db8::47',
	shopEmail: 'sales@medsupply-direct.example',
	shopDomain: 'medsupply-direct.example',
	checkoutUrl: `http://${HOSTS.shop}/checkout`,
	kovalEmail: 'm.koval@brightwater-holdings.example',
	phone: '+44 20 7946 0958',
}

/** Phrases the investigator highlights; each appears once on its page. */
export const HIGHLIGHTS = {
	rotterdam: 'Shipping from our Rotterdam partner within 48 hours, tracked to your door.',
	dispatch: 'All orders are dispatched by Northgate Freight BV from Rotterdam.',
	incorporated: 'Brightwater Holdings Ltd was incorporated on 3 March 2024.',
	secretary: 'Company secretary: Corpserve Secretarial Ltd',
}

const PAGE_STYLE = `
	body { font: 16px/1.5 Georgia, serif; margin: 0; background: #f6f4ef; color: #222; }
	header { background: #1f3a4d; color: #fff; padding: 14px 32px; }
	header a { color: #cfe3f2; }
	main { max-width: 820px; margin: 24px auto; padding: 0 24px 48px; background: #fff; }
	.post { border-bottom: 1px solid #ddd; padding: 16px 0; }
	.meta { color: #777; font-size: 13px; }
	code, pre { font-family: ui-monospace, monospace; font-size: 13px; background: #f1f1f1; }
	pre { padding: 8px 12px; white-space: pre-wrap; }
	table { border-collapse: collapse; width: 100%; }
	td { border-bottom: 1px solid #eee; padding: 6px 4px; vertical-align: top; }
	td:first-child { color: #555; width: 38%; }
	footer { text-align: center; font: 12px sans-serif; color: #999; padding: 16px; }
`

function page(title: string, header: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${PAGE_STYLE}</style></head>
<body><header>${header}</header><main>${body}</main>
<footer>A fictional page made for the OSINT Copilot demo investigation. Nothing on it is real.</footer></body></html>`
}

function forumThread(): string {
	const filler = [
		['kestrel_buyer', 'Received mine last week. Blister packs look right, batch numbers too. Took four days to Brussels.'],
		['nightowl88', 'Anyone tested these? The imprint on the tablets is slightly off compared to the pharmacy ones.'],
		['harbor_pharma', 'Imprint changed with the new supplier batch, same active ingredient. We replace anything damaged.'],
		['m_rossi', 'Customs in Milan opened my parcel, it went through anyway. Declared as "food supplements".'],
		['nightowl88', 'Declared as supplements? That is going to end badly for somebody.'],
		['harbor_pharma', 'All parcels leave consolidated. Nobody opens a pallet of supplements.'],
		['baltic_bee', 'Collected mine from a parcel locker in Tallinn. The label said Baltic Parcel Consolidation OU.'],
		['quiet_lark', 'Their clearnet shop was down Tuesday, checkout errored out.'],
		['harbor_pharma', 'Moved hosting, back now. Same shop, same prices.'],
		['m_rossi', 'Somebody said the Benelux orders come out of a stash in Antwerp. Anyone confirm?'],
		['nightowl88', 'Heard they have a second supplier in Riga now. Could explain the new imprint.'],
	]
	const posts = filler.map(([who, text], i) => `
	<div class="post"><div class="meta">#${i + 3} · <strong>${who}</strong> · 2024-04-${String(12 + i).padStart(2, '0')}</div><p>${text}</p></div>`).join('')
	return page(
		'[WTS] Oncology generics, EU shipping · Harbour Market',
		'<strong>Harbour Market</strong> · Marketplace › Pharmacy › thread 4471',
		`<h1>[WTS] Oncology generics, EU shipping</h1>
	<div class="post"><div class="meta">#1 · <strong>harbor_pharma</strong> · vendor since 2023 · 2024-04-10</div>
	<p>Generic capecitabine, imatinib and anastrozole, sealed blisters, no prescription needed.</p>
	<p>${HIGHLIGHTS.rotterdam}</p>
	<p>Payment in crypto only. BTC: <code>${VALUES.btc}</code><br>ETH: <code>${VALUES.eth}</code></p>
	<p>Prefer card? Order through our clearnet shop: ${VALUES.shopDomain}</p></div>
	<div class="post"><div class="meta">#2 · <strong>quiet_lark</strong> · 2024-04-11</div>
	<p>Their checkout leaks its upstream in the error page, for what it is worth:</p>
	<pre>[2024-04-14 22:13:07] checkout ok  order=88213  upstream ${VALUES.ipv4}:443</pre></div>
	${posts}`)
}

function shop(): string {
	return page(
		'MedSupply Direct · Oncology generics without prescription',
		'<strong>MedSupply Direct</strong> · Home · Products · <a href="/checkout">Checkout</a>',
		`<h1>Oncology generics, delivered discreetly</h1>
	<p>Quality generics at a fraction of pharmacy prices. No prescription, no questions.</p>
	<p>${HIGHLIGHTS.dispatch}</p>
	<h2>Contact</h2>
	<p>Orders and support: ${VALUES.shopEmail}</p>
	<p>Secure checkout: ${VALUES.checkoutUrl}</p>
	<p class="meta">Status: all systems normal · served from ${VALUES.ipv6}</p>`)
}

function registry(): string {
	return page(
		'BRIGHTWATER HOLDINGS LTD · HE 412345 · Company Registry',
		'<strong>Registrar of Companies</strong> (fictional) · Search › HE 412345',
		`<h1>BRIGHTWATER HOLDINGS LTD</h1>
	<p>${HIGHLIGHTS.incorporated}</p>
	<table>
		<tr><td>Registration number</td><td>HE 412345</td></tr>
		<tr><td>Status</td><td>Active</td></tr>
		<tr><td>Registered office</td><td>Arch. Makariou III Avenue, Limassol</td></tr>
		<tr><td>Director</td><td>Marta Koval (appointed 3 March 2024)</td></tr>
		<tr><td>Shareholder</td><td>Aurelia Trade LP (Seychelles), 100%</td></tr>
		<tr><td>Contact e-mail on file</td><td>${VALUES.kovalEmail}</td></tr>
	</table>
	<p>${HIGHLIGHTS.secretary}</p>`)
}

function northgateContact(): string {
	return page(
		'Contact · Northgate Freight BV',
		'<strong>Northgate Freight BV</strong> · Services · Warehousing · Contact',
		`<h1>Contact Northgate Freight</h1>
	<p>Consolidation, customs clearance and last-mile delivery across the EU.</p>
	<table>
		<tr><td>Warehouse</td><td>Waalhaven Zuidzijde, Rotterdam</td></tr>
		<tr><td>UK sales line</td><td>${VALUES.phone}</td></tr>
		<tr><td>Board contact</td><td>${VALUES.kovalEmail}</td></tr>
		<tr><td>Quarterly reports</td><td><a href="${URLS.manifestPdf}">Q2 2024 consolidation manifest (PDF)</a></td></tr>
	</table>`)
}

/** What a browser shows for the PDF address: a viewer page (see make-demo for why). */
function pdfViewer(): string {
	return page(
		'q2-2024-consolidation.pdf',
		'<strong>Document viewer</strong> · q2-2024-consolidation.pdf',
		`<h1>Northgate Freight BV: consolidation manifest, Q2 2024</h1>
	<p>Consignments consolidated at the Waalhaven warehouse and declared as food supplements.</p>
	<table>
		<tr><td>2024-04-18</td><td>Pallet NGF-2204, 212 parcels, declared "food supplements"</td></tr>
		<tr><td>2024-05-09</td><td>Pallet NGF-2231, 188 parcels, declared "food supplements"</td></tr>
		<tr><td>2024-06-19</td><td>Pallet NGF-2260, 38 parcels held by customs</td></tr>
	</table>`)
}

export const PAGES: Record<string, () => string> = {
	[URLS.forumThread]: forumThread,
	[URLS.shop]: shop,
	[URLS.registry]: registry,
	[URLS.northgateContact]: northgateContact,
	[URLS.manifestPdf]: pdfViewer,
}

/**
 * A small, valid PDF (one page of Helvetica text), built by hand so the demo needs no
 * PDF library: objects, then an xref table with their byte offsets.
 */
export function manifestPdf(): Buffer {
	const lines = [
		'Northgate Freight BV - consolidation manifest, Q2 2024',
		'',
		'2024-04-18  Pallet NGF-2204  212 parcels  declared: food supplements',
		'2024-05-09  Pallet NGF-2231  188 parcels  declared: food supplements',
		'2024-06-19  Pallet NGF-2260   38 parcels  held by customs, Rotterdam',
		'',
		'Consignee on file: Brightwater Holdings Ltd, Limassol',
		'',
		'A fictional document made for the OSINT Copilot demo investigation.',
	]
	const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 14 : 11} Tf 56 ${780 - i * 20} Td (${l.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n')
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	]
	let out = '%PDF-1.4\n'
	const offsets: number[] = []
	objects.forEach((body, i) => {
		offsets.push(Buffer.byteLength(out))
		out += `${i + 1} 0 obj\n${body}\nendobj\n`
	})
	const xref = Buffer.byteLength(out)
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
	out += offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	return Buffer.from(out, 'latin1')
}

// ------------------------------------------------------------------ entities made through the app

export type EntitySpec = {
	key: string
	id: string
	/** 'ftm' → createFTMEntity(schema); 'legacy' → createEntity(type). */
	api: 'ftm' | 'legacy'
	schema: string
	label: string
	properties: Record<string, unknown>
	sources?: SourceInput[]
	/** A generated picture: initials on a colour. */
	picture?: { initials: string, color: string, shape: 'person' | 'logo' }
}

export const ENTITIES: EntitySpec[] = [
	// People. Confidence rises with independent sources: Koval one (low), Arendt two (medium).
	{
		key: 'koval', id: demoId(1), api: 'ftm', schema: 'Person', label: 'Marta Koval',
		properties: {
			name: 'Marta Koval', firstName: 'Marta', lastName: 'Koval', nationality: 'cy', birthDate: '1979-04-11',
			position: 'Director, Brightwater Holdings Ltd',
			notes: 'Sole director of Brightwater since incorporation. Her e-mail is also the board contact on Northgate Freight\'s website.',
		},
		sources: [source(URLS.registry, 'Named as director in the registry extract')],
		picture: { initials: 'MK', color: '#7b4fa0', shape: 'person' },
	},
	{
		key: 'arendt', id: demoId(2), api: 'ftm', schema: 'Person', label: 'Daniel Arendt',
		properties: {
			name: 'Daniel Arendt', firstName: 'Daniel', lastName: 'Arendt', nationality: 'nl',
			position: 'Managing director, Northgate Freight BV',
			notes: 'Quoted in the customs seizure coverage as saying the pallets were "declared correctly by the shipper".',
		},
		sources: [
			source(URLS.kvk, 'Managing director in the trade register'),
			source(URLS.news, 'Quoted by name in the seizure article'),
		],
		picture: { initials: 'DA', color: '#2f7d6d', shape: 'person' },
	},
	{
		key: 'ferris', id: demoId(3), api: 'ftm', schema: 'Person', label: 'Jonah Ferris',
		properties: {
			name: 'Jonah Ferris', position: 'Nominee director',
			notes: 'Director of more than 40 Seychelles entities at the same registered agent: a professional nominee, not the owner.',
		},
		// Only an inference so far: the note says unverified until a record names him.
		sources: [{ source_url: URLS.agentList, inferred: true, rationale: 'Inferred from the registered agent\'s published nominee list', captured_at: CAPTURED, archive_status: 'skipped' }],
	},

	// Companies. Brightwater is "conflicted": two sources disagree on its country.
	{
		key: 'brightwater', id: demoId(4), api: 'ftm', schema: 'Company', label: 'Brightwater Holdings Ltd',
		properties: {
			name: 'Brightwater Holdings Ltd', jurisdiction: 'cy', country: 'cy', registrationNumber: 'HE 412345',
			incorporationDate: '2024-03-03', status: 'Active', legalForm: 'Private limited company', sector: 'Holding company',
			notes: 'Owns 60% of Northgate Freight BV since April 2024. Owned in turn by Aurelia Trade LP (Seychelles).',
		},
		sources: [
			source(URLS.registry, 'Registry extract', [{ path: 'properties.country', value: 'cy' }]),
			source(URLS.leakedInvoice, 'Leaked invoice gives a Maltese address for the same company number', [{ path: 'properties.country', value: 'mt' }]),
		],
		picture: { initials: 'BH', color: '#1f5c99', shape: 'logo' },
	},
	{
		key: 'northgate', id: demoId(5), api: 'ftm', schema: 'Company', label: 'Northgate Freight BV',
		properties: {
			name: 'Northgate Freight BV', jurisdiction: 'nl', country: 'nl', registrationNumber: '81234567',
			incorporationDate: '2019-06-12', status: 'Active', legalForm: 'Besloten vennootschap', sector: 'Freight forwarding',
			website: `https://${HOSTS.northgate}`,
		},
		// Three independent sources: high confidence.
		sources: [
			source(URLS.kvk, 'Trade register entry'),
			source(URLS.news, 'Named as the forwarder of the seized pallets'),
			source(URLS.customs, 'Customs press release names the forwarder'),
		],
		picture: { initials: 'NF', color: '#b8611c', shape: 'logo' },
	},
	{
		key: 'aurelia', id: demoId(6), api: 'ftm', schema: 'ShellCompany', label: 'Aurelia Trade LP',
		properties: {
			name: 'Aurelia Trade LP', country: 'sc', registeredAgent: 'Corpserve (Seychelles) Ltd', nomineeDirector: 'Jonah Ferris',
			incorporationDate: '2023-11-20',
		},
		sources: [source(URLS.registry, 'Listed as Brightwater\'s sole shareholder')],
	},
	{
		key: 'harbour', id: demoId(7), api: 'ftm', schema: 'Organization', label: 'Harbour Market',
		properties: {
			name: 'Harbour Market', description: 'Invite-only marketplace where harbor_pharma sells', website: `http://${HOSTS.forum}`,
		},
		sources: [source(URLS.forumThread, 'The seller\'s thread is hosted here')],
	},
	{
		key: 'van', id: demoId(8), api: 'ftm', schema: 'Vehicle', label: 'Delivery van VX-492-K',
		properties: { name: 'Delivery van VX-492-K', registrationNumber: 'VX-492-K', model: 'Ford Transit Custom' },
		sources: [source(URLS.news, 'Photographed at the warehouse gate in the seizure article')],
	},
	{
		key: 'northgateDomain', id: demoId(9), api: 'ftm', schema: 'Domain', label: 'northgate-freight.example',
		properties: { name: HOSTS.northgate },
		sources: [source(URLS.kvk, 'Website listed in the trade register')],
	},

	// Places, with coordinates: the map needs no geocoding service.
	{
		key: 'limassol', id: demoId(20), api: 'legacy', schema: 'Location', label: 'Brightwater registered office',
		properties: {
			name: 'Brightwater registered office', address: 'Arch. Makariou III Avenue', city: 'Limassol', country: 'Cyprus',
			latitude: 34.6786, longitude: 33.0413, location_type: 'registered office',
			significance: 'A registered agent\'s address, shared by about 200 companies',
		},
		sources: [source(URLS.registry, 'Registered office in the registry extract')],
	},
	{
		key: 'waalhaven', id: demoId(21), api: 'legacy', schema: 'Location', label: 'Northgate warehouse, Waalhaven',
		properties: {
			name: 'Northgate warehouse, Waalhaven', address: 'Waalhaven Zuidzijde', city: 'Rotterdam', country: 'Netherlands',
			latitude: 51.8835, longitude: 4.4389, location_type: 'warehouse',
			significance: 'Where the seized pallets were consolidated',
		},
		sources: [source(URLS.news, 'Warehouse named in the seizure article')],
	},
	{
		key: 'tallinn', id: demoId(22), api: 'legacy', schema: 'Location', label: 'Parcel drop point, Tallinn',
		properties: {
			name: 'Parcel drop point, Tallinn', address: 'Parcel lockers, Kesklinn', city: 'Tallinn', country: 'Estonia',
			latitude: 59.437, longitude: 24.7536, location_type: 'drop point',
		},
		sources: [source(URLS.forumThread, 'Buyers mention collecting from a Tallinn locker')],
	},
	{
		key: 'victoria', id: demoId(23), api: 'legacy', schema: 'Location', label: 'Aurelia registered agent, Victoria',
		properties: {
			name: 'Aurelia registered agent, Victoria', address: 'Corpserve (Seychelles) Ltd', city: 'Victoria', country: 'Seychelles',
			latitude: -4.6191, longitude: 55.4513, location_type: 'registered agent',
		},
		sources: [source(URLS.agentList, 'Registered agent\'s own listing')],
	},
	{
		// No coordinates on purpose: the map lists it under "Geolocate missing".
		key: 'antwerp', id: demoId(24), api: 'legacy', schema: 'Location', label: 'Suspected stash, Antwerp',
		properties: {
			name: 'Suspected stash, Antwerp', address: 'Noorderlaan', city: 'Antwerp', country: 'Belgium',
			location_type: 'suspected storage', significance: 'Mentioned once on the forum; not yet located',
		},
		sources: [source(URLS.forumThread, 'A buyer mentions an Antwerp pickup')],
	},

	// Events for the timeline.
	...([
		[30, 'Northgate Freight BV incorporated', '2019-06-12', undefined, URLS.kvk],
		[31, 'medsupply-direct.example registered', '2023-09-18', undefined, URLS.forumThread],
		[32, 'Aurelia Trade LP incorporated in the Seychelles', '2023-11-20', undefined, URLS.agentList],
		[33, 'Brightwater Holdings Ltd incorporated', '2024-03-03', undefined, URLS.registry],
		[34, 'First BTC payment reaches the seller wallet', '2024-04-15 09:30', '2024-04-15 09:45', URLS.forumThread],
		[35, 'Koval and Arendt meet at the Waalhaven warehouse', '2024-05-02 14:00', '2024-05-02 16:00', URLS.news],
		[36, 'Rotterdam customs seize 38 parcels', '2024-06-20', undefined, URLS.customs],
		[37, 'Rumoured second supplier in Riga', '', undefined, URLS.forumThread],
	] as const).map(([n, name, start, end, url]): EntitySpec => ({
		key: `event${n}`, id: demoId(n), api: 'legacy', schema: 'Event', label: name,
		properties: {
			name, add_to_timeline: true,
			...(start ? { start_date: start } : {}),
			...(end ? { end_date: end } : {}),
			...(start ? {} : { description: 'Undated: one forum post, no corroboration yet.' }),
		},
		sources: [source(url, 'Reported here')],
	})),
]

/** Connections made through the app once every entity exists. Keys name ENTITIES or extension items. */
export type ConnectionSpec = {
	from: string
	to: string
	relationship: string
	properties?: Record<string, unknown>
	family?: 'ftm' | 'stix2' | 'mitre' | 'user'
	sources?: SourceInput[]
}

export const CONNECTIONS: ConnectionSpec[] = [
	{ from: 'koval', to: 'brightwater', relationship: 'Directorship', properties: { role: 'Director', startDate: '2024-03-03' }, sources: [source(URLS.registry, 'Appointment in the registry extract')] },
	{ from: 'arendt', to: 'northgate', relationship: 'Directorship', properties: { role: 'Managing director', startDate: '2019-06-12' }, sources: [source(URLS.kvk, 'Trade register')] },
	{ from: 'ferris', to: 'aurelia', relationship: 'Directorship', properties: { role: 'Nominee director' } },
	{ from: 'aurelia', to: 'brightwater', relationship: 'Ownership', properties: { percentage: '100', startDate: '2024-03-03' }, sources: [source(URLS.registry, 'Sole shareholder')] },
	{ from: 'brightwater', to: 'northgate', relationship: 'Ownership', properties: { percentage: '60', startDate: '2024-04-01' }, sources: [source(URLS.leakedInvoice, 'Share transfer referenced on the invoice')] },
	{ from: 'brightwater', to: 'northgate', relationship: 'Payment', properties: { amount: '48000', date: '2024-05-10', purpose: 'Freight services, invoice 0412' }, sources: [source(URLS.leakedInvoice, 'The leaked invoice')] },
	{ from: 'ferris', to: 'koval', relationship: 'NomineeFor', properties: { fee: 'EUR 2,000 a year', startDate: '2023-11-20' } },
	{ from: 'koval', to: 'arendt', relationship: 'Associate', properties: { relationship: 'Business associates; met at the warehouse' } },
	{ from: 'brightwater', to: 'limassol', relationship: 'UnknownLink', properties: { role: 'Registered office' } },
	{ from: 'northgate', to: 'waalhaven', relationship: 'UnknownLink', properties: { role: 'Warehouse' } },
	{ from: 'aurelia', to: 'victoria', relationship: 'UnknownLink', properties: { role: 'Registered agent' } },
	{ from: 'northgate', to: 'van', relationship: 'UnknownLink', properties: { role: 'Company van' } },
	{ from: 'northgate', to: 'northgateDomain', relationship: 'UnknownLink', properties: { role: 'Website' } },
	{ from: 'koval', to: 'event35', relationship: 'PARTICIPATED_IN' },
	{ from: 'arendt', to: 'event35', relationship: 'PARTICIPATED_IN' },
	{ from: 'northgate', to: 'event36', relationship: 'PARTICIPATED_IN' },
	{ from: 'event36', to: 'waalhaven', relationship: 'OCCURRED_AT' },
	// Items the extension sent (keys set by make-demo from the activity outcomes).
	{ from: 'x:sellerUsername', to: 'harbour', relationship: 'SELLS_ON' },
	{ from: 'x:sellerUsername', to: 'x:shopDomain', relationship: 'ADVERTISES' },
	{ from: 'x:btc', to: 'x:sellerUsername', relationship: 'RECEIVES_PAYMENTS_FOR' },
	{ from: 'x:eth', to: 'x:sellerUsername', relationship: 'RECEIVES_PAYMENTS_FOR' },
	{ from: 'x:shopDomain', to: 'x:ipv4', relationship: 'HOSTED_ON' },
	{ from: 'x:shopDomain', to: 'x:ipv6', relationship: 'HOSTED_ON' },
	{ from: 'x:shopEmail', to: 'x:shopDomain', relationship: 'CONTACT_FOR' },
	{ from: 'x:checkoutUrl', to: 'x:shopDomain', relationship: 'PAGE_OF' },
	{ from: 'x:shopDomain', to: 'northgate', relationship: 'NAMES_AS_SHIPPER' },
	{ from: 'koval', to: 'x:kovalEmail', relationship: 'USES_EMAIL' },
	{ from: 'northgate', to: 'x:phone', relationship: 'USES_PHONE' },
	{ from: 'x:btc', to: 'event34', relationship: 'PARTICIPATED_IN' },
]

// ------------------------------------------------------------------ files written before the app starts

/** Settings the plugin reads at load, merged into what the harness seeds. */
export const SETTINGS = {
	hasSeenWelcomeGuide: true,
	activeAgentId: 'case-analyst',
	graphWorkspaces: [{ id: 'default', name: 'Default' }, { id: 'money-trail', name: 'Money trail' }],
	activeGraphId: 'default',
	oidsfModalLayers: { world: true, links: true, cyber: true, analysis: false },
	extensionAllowWayback: false,
	preferredTaskAgentId: 'case-memo',
}

export const CUSTOM_TYPES = {
	schemas: [
		{
			name: 'ShellCompany', label: 'Shell company', plural: 'Shell companies',
			description: 'A company run by nominees, with no operations of its own',
			extends: ['Thing'],
			properties: {
				registeredAgent: { label: 'Registered agent', type: 'string', description: 'Who files for it' },
				nomineeDirector: { label: 'Nominee director', type: 'string', description: 'The name on the register' },
				incorporationDate: { label: 'Incorporation date', type: 'date', description: '' },
			},
			required: ['registeredAgent'],
			featured: ['registeredAgent', 'nomineeDirector'],
			caption: ['name', 'registeredAgent', 'nomineeDirector'],
			color: '#8E24AA',
		},
		{
			name: 'NomineeFor', label: 'Nominee for', plural: 'Nominee relationships',
			description: 'Acts on the register on behalf of a hidden principal',
			extends: ['Interval'],
			properties: {
				nominee: { label: 'Nominee', type: 'entity', range: 'Person', description: '' },
				principal: { label: 'Principal', type: 'entity', description: '' },
				fee: { label: 'Fee', type: 'string', description: '' },
			},
			required: [],
			featured: ['fee'],
			caption: ['name'],
			color: '#6D4C41',
		},
	],
}

export const USER_SCHEMA = `version: 1
family: user
entityTypes:
  - name: parcel-batch
    label: Parcel batch
    plural: Parcel batches
    description: A consolidated batch of parcels, as the forwarder's manifest lists it
    color: "#00695c"
    labelField: name
    required: [name]
    featured: [name, parcels, declared_as, seized_at]
    properties:
      name: { label: Name, type: string }
      parcels: { label: Parcels, type: number }
      declared_as: { label: Declared as, type: string }
      seized_at: { label: Seized at, type: date }
relationshipTypes:
  - name: shipped-via
    label: Shipped via
    properties:
      description: { label: Notes, type: text }
`

const RULES = `# Case rules: ${CASE_NAME}

- Grade every claim by its sources. One source is a lead, two independent sources are a finding, three make it solid. Say which you have.
- Registry extracts outrank marketing pages. A leaked document is a lead until something independent agrees with it.
- Never state that a person committed a crime. Describe what the records show and who they name.
- Cite the note you used for each claim as a [[wikilink]], and say when you are inferring.
- The seller's own statements (forum posts, shop pages) are claims about themselves, not facts.
`

const CASE_ANALYST = `---
id: case-analyst
name: Case analyst
description: Financial-crime analyst for the Northgate case
order: 1
---

You are the analyst on ${CASE_NAME}: a counterfeit-medicine seller, the freight forwarder that ships
for it, and the companies that own the forwarder. Follow the money and the parcels. Prefer
company records and payment data to anything the seller says about itself, and keep a short list
of open questions at the end of every answer.
`

const ENRICHER_LOG = `2026-09-18T08:41:12Z enricher=crtsh-subdomains query=medsupply-direct.example status=429 retry_after=30s
2026-09-18T08:41:44Z enricher=crtsh-subdomains query=medsupply-direct.example status=200 results=0
2026-09-18T08:42:03Z enricher=rdap-domain query=medsupply-direct.example status=404 note="reserved .example domain, no RDAP record"
`

const SKILLS: Record<string, string> = {
	'company_ownership_trace.md': `---
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
`,
	'crypto_wallet_triage.md': `---
skill_kind: vault
id: crypto_wallet_triage
name: "Crypto wallet triage"
description: "First look at a wallet a seller publishes"
---

- Note the chain and where the address was published, with the page as the source.
- Check whether the same address appears on other pages of the case (search the vault first).
- Link the wallet to the seller's account with RECEIVES_PAYMENTS_FOR, never to a person directly.
- List what a blockchain explorer would answer next: first seen, volume, counterparties.
`,
	'counterfeit_shop_checklist.md': `---
skill_kind: vault
id: counterfeit_shop_checklist
name: "Counterfeit shop checklist"
description: "What to collect from a shop selling fake medicines"
---

- Capture the landing page, the product page and the checkout page.
- Send the contact e-mail, the domain and any hosting clues as entities.
- Highlight where the shop names its shipper or payment processor.
- Look for the same shop advertised on forums and marketplaces.
`,
}

const ENRICHERS: Record<string, object> = {
	'rdap-domain.json': {
		id: 'rdap-domain', name: 'RDAP domain lookup', description: 'Registration data for a domain, from the public RDAP bootstrap',
		documentationUrl: 'https://about.rdap.org/', status: 'active', enabled: true, allowedDomains: ['rdap.org'],
		auth: { type: 'none' }, request: { method: 'GET', urlTemplate: 'https://rdap.org/domain/{{query}}', headers: {} },
		inputHints: ['domain'], skillInstructions: 'Use for a domain\'s registrar, dates and nameservers.',
		limits: { timeoutMs: 15000, retries: 1, maxResponseChars: 8000 }, updatedAt: '2026-09-17T10:00:00.000Z',
	},
	'crtsh-subdomains.json': {
		id: 'crtsh-subdomains', name: 'crt.sh subdomains', description: 'Certificates issued for a domain, from Certificate Transparency logs',
		documentationUrl: 'https://crt.sh/', status: 'active', enabled: true, allowedDomains: ['crt.sh'],
		auth: { type: 'none' }, request: { method: 'GET', urlTemplate: 'https://crt.sh/?q=%25.{{query}}&output=json', headers: {} },
		inputHints: ['domain'], skillInstructions: 'Use to find a domain\'s subdomains and when their certificates were issued.',
		limits: { timeoutMs: 20000, retries: 1, maxResponseChars: 12000 }, updatedAt: '2026-09-17T10:05:00.000Z',
	},
	'leakcheck.json': {
		id: 'leakcheck', name: 'Breach lookup (keyed)', description: 'Whether an e-mail address appears in known breaches',
		status: 'active', enabled: true, allowedDomains: ['leakcheck.io'],
		auth: { type: 'bearer_vault', vaultRelativePath: 'leakcheck/api-key.txt' },
		request: { method: 'GET', urlTemplate: 'https://leakcheck.io/api/v2/query/{{query}}', headers: {} },
		inputHints: ['email'], skillInstructions: 'Use for an e-mail address; report breach names and dates only.',
		limits: { timeoutMs: 15000, retries: 0, maxResponseChars: 6000 }, updatedAt: '2026-09-17T10:10:00.000Z',
	},
	'shodan-host.json': {
		id: 'shodan-host', name: 'Shodan host (draft)', description: 'Open ports and banners for an IP address',
		status: 'draft', enabled: false, allowedDomains: ['api.shodan.io'],
		auth: { type: 'query_env', envVar: 'SHODAN_API_KEY', queryParam: 'key' },
		request: { method: 'GET', urlTemplate: 'https://api.shodan.io/shodan/host/{{query}}', headers: {} },
		inputHints: ['ip'], skillInstructions: 'Draft: needs a key before it is enabled.',
		limits: { timeoutMs: 15000, retries: 1, maxResponseChars: 8000 }, updatedAt: '2026-09-17T10:15:00.000Z',
	},
}

const ENRICHER_AUDIT = `# Enricher audit log

- 2026-09-17T10:00:21.000Z approved create_or_update id=rdap-domain doc=https://about.rdap.org/
- 2026-09-17T10:05:40.000Z approved create_or_update id=crtsh-subdomains doc=https://crt.sh/
- 2026-09-17T10:10:02.000Z approved create_or_update id=leakcheck doc=https://leakcheck.io/
`

export const PIVOT_SCRIPT_V1 = `"""Pivot from a domain to related domains. Version 1: shared nameservers only."""
import json
import sys


def pivot(domain: str) -> list[str]:
    # Placeholder: a real run would ask a passive-DNS source for domains on the same nameservers.
    return []


if __name__ == "__main__":
    print(json.dumps({"domain": sys.argv[1], "related": pivot(sys.argv[1])}))
`

export const PIVOT_SCRIPT_V2 = `"""Pivot from a domain to related domains: shared nameservers, then certificates."""
import json
import sys
import urllib.request


def from_certificates(domain: str) -> list[str]:
    # Certificate Transparency: every name on a certificate issued for the domain.
    with urllib.request.urlopen(f"https://crt.sh/?q=%25.{domain}&output=json", timeout=20) as r:
        rows = json.load(r)
    return sorted({name for row in rows for name in row["name_value"].split("\\n")})


def pivot(domain: str) -> list[str]:
    # Placeholder: a real run would ask a passive-DNS source for domains on the same nameservers.
    return from_certificates(domain)


if __name__ == "__main__":
    print(json.dumps({"domain": sys.argv[1], "related": pivot(sys.argv[1])}))
`

const TASK_AGENT = `---
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
`

/** Files under the workspace, written before the app starts. The plugin adds only what is missing. */
export const STATIC_FILES: Record<string, string> = {
	'OSINTCopilot/custom/prompts/rules/global.md': RULES,
	'OSINTCopilot/custom/prompts/agents/case-analyst.md': CASE_ANALYST,
	'OSINTCopilot/custom/prompts/logs/2026-09-18-enricher-debug.log': ENRICHER_LOG,
	...Object.fromEntries(Object.entries(SKILLS).map(([name, body]) => [`OSINTCopilot/custom/skills/${name}`, body])),
	...Object.fromEntries(Object.entries(ENRICHERS).map(([name, spec]) => [`OSINTCopilot/custom/enrichers/${name}`, `${JSON.stringify(spec, null, 2)}\n`])),
	'OSINTCopilot/custom/enrichers/audit.log.md': ENRICHER_AUDIT,
	// Not a real key: the keyed enricher is there to show how credentials are wired.
	'OSINTCopilot/custom/credentials/leakcheck/api-key.txt': 'DEMO-NOT-A-REAL-KEY\n',
	'OSINTCopilot/custom/scripts/tools/pivot_domains.py': PIVOT_SCRIPT_V1,
	'OSINTCopilot/custom/task-agents/case-memo.md': TASK_AGENT,
	'OSINTCopilot/custom/custom-types.json': `${JSON.stringify(CUSTOM_TYPES, null, 2)}\n`,
	'OSINTCopilot/schemas/user/case-types.yaml': USER_SCHEMA,
}
