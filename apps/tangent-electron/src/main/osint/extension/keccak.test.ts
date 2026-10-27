import { describe, it, expect } from 'vitest'
import { keccak256, toEip55, isValidEthAddress } from './keccak'

/**
 * Ethereum's Keccak-256 is not FIPS SHA3-256 (different padding), so it is hand-written
 * and checked here against published answers rather than against node:crypto.
 */
describe('keccak256', () => {
	it('matches the known answer for the empty string', () => {
		expect(keccak256('').toString('hex')).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
	})

	it('matches the known answer for "abc"', () => {
		expect(keccak256('abc').toString('hex')).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
	})

	it('differs from FIPS SHA3-256, which pads differently', () => {
		// SHA3-256("") -- what node:crypto would have given.
		expect(keccak256('').toString('hex')).not.toBe('a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a')
	})

	it('absorbs inputs that span several blocks, including one exactly a block long', () => {
		// The rate is 136 bytes; 135 puts both padding bits in one byte, 136 forces a new block.
		const lengths = [135, 136, 137, 272, 1000]
		const digests = lengths.map(n => keccak256(Buffer.alloc(n, 0x61)).toString('hex'))
		expect(new Set(digests).size).toBe(lengths.length)
		for (const d of digests) expect(d).toMatch(/^[0-9a-f]{64}$/)
	})
})

describe('EIP-55', () => {
	// The checksummed addresses from the EIP-55 specification.
	const checksummed = [
		'0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
		'0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
		'0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
		'0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
	]

	it.each(checksummed)('computes and accepts %s', address => {
		expect(toEip55(address.toLowerCase())).toBe(address)
		expect(isValidEthAddress(address)).toBe(true)
	})

	it('accepts single-case addresses, which carry no checksum', () => {
		expect(isValidEthAddress('0x52908400098527886E0F7030069857D2E4169EE7')).toBe(true)
		expect(isValidEthAddress('0xde709f2102306220921060314715629080e2fb77')).toBe(true)
	})

	it('rejects a mixed-case address with one letter flipped', () => {
		expect(isValidEthAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBe(false)
	})

	it('rejects the wrong length or non-hex', () => {
		expect(isValidEthAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe')).toBe(false)
		expect(isValidEthAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeg')).toBe(false)
		expect(isValidEthAddress('5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(false)
	})
})
