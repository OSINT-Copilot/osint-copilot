import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { sniffCaptureFile } from './sniff'

const blink = fs.readFileSync(path.join(__dirname, 'fixtures', 'blink-page.mhtml'))
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const pdf = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')

describe('does the content match the name', () => {
	it('accepts each kind under its own name', () => {
		expect(sniffCaptureFile('page.mhtml', blink)).toBe(true)
		expect(sniffCaptureFile('viewport.png', png)).toBe(true)
		expect(sniffCaptureFile('page.pdf', pdf)).toBe(true)
	})

	it('refuses each kind under another name', () => {
		expect(sniffCaptureFile('page.mhtml', png)).toBe(false)
		expect(sniffCaptureFile('page.mhtml', pdf)).toBe(false)
		expect(sniffCaptureFile('viewport.png', blink)).toBe(false)
		expect(sniffCaptureFile('page.pdf', png)).toBe(false)
	})

	it('wants a multipart/related archive, not any MIME-ish text', () => {
		expect(sniffCaptureFile('page.mhtml', Buffer.from('<html><body>hi</body></html>'))).toBe(false)
		expect(sniffCaptureFile('page.mhtml', Buffer.from('Content-Type: text/html\r\n\r\n<p>x</p>'))).toBe(false)
		expect(sniffCaptureFile('page.mhtml', Buffer.from('Content-Type: multipart/related\r\n\r\nno boundary'))).toBe(false)
		expect(sniffCaptureFile('page.mhtml', Buffer.from('junk line\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n'))).toBe(false)
		expect(sniffCaptureFile('page.mhtml', Buffer.alloc(0))).toBe(false)
	})
})
