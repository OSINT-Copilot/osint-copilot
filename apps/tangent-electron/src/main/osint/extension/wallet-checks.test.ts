import { describe, it, expect } from 'vitest'
import { isValidBase58Check, isValidSegwitAddress, isValidBtcAddress } from './wallet-checks'

describe('Base58Check', () => {
	it('accepts the genesis P2PKH address and a P2SH address', () => {
		expect(isValidBase58Check('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true)
		expect(isValidBase58Check('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true)
	})

	it('rejects a one-character typo (checksum)', () => {
		expect(isValidBase58Check('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb')).toBe(false)
	})

	it('rejects characters outside the alphabet', () => {
		expect(isValidBase58Check('1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf0a')).toBe(false)
	})
})

describe('bech32 / bech32m', () => {
	// Valid addresses from BIP-173 and BIP-350.
	it.each([
		'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
		'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
		'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
	])('accepts %s', address => {
		expect(isValidSegwitAddress(address)).toBe(true)
	})

	// Invalid addresses from BIP-350: the wrong checksum constant for the witness version.
	it.each([
		'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh',
		'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd',
	])('rejects %s', address => {
		expect(isValidSegwitAddress(address)).toBe(false)
	})

	it('rejects mixed case, a foreign hrp, and a flipped character', () => {
		expect(isValidSegwitAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kV8f3t4')).toBe(false)
		expect(isValidSegwitAddress('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false)
		expect(isValidSegwitAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')).toBe(false)
	})

	it('isValidBtcAddress accepts either form', () => {
		expect(isValidBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true)
		expect(isValidBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true)
		expect(isValidBtcAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(false)
	})
})
