/**
 * Bitcoin address checksums: Base58Check (legacy P2PKH/P2SH) and bech32/bech32m (SegWit).
 *
 * The point is to reject a mistyped or half-selected address before it becomes an entity
 * that pivots and enrichers then chase. These are checksum and structure checks only;
 * they say nothing about whether an address was ever used.
 */
import { createHash } from 'crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** P2PKH and P2SH, mainnet and testnet. */
const BASE58_VERSIONS = new Set([0x00, 0x05, 0x6f, 0xc4]);

function sha256(data: Buffer): Buffer {
    return createHash('sha256').update(data).digest();
}

export function base58Decode(text: string): Buffer | null {
    let value = 0n;
    for (const ch of text) {
        const digit = BASE58_ALPHABET.indexOf(ch);
        if (digit < 0) return null;
        value = value * 58n + BigInt(digit);
    }
    const bytes: number[] = [];
    while (value > 0n) {
        bytes.unshift(Number(value & 0xffn));
        value >>= 8n;
    }
    // Each leading '1' encodes one leading zero byte.
    for (let i = 0; i < text.length && text[i] === '1'; i++) bytes.unshift(0);
    return Buffer.from(bytes);
}

/** A 25-byte version + hash160 + 4-byte double-SHA256 checksum, with a Bitcoin version byte. */
export function isValidBase58Check(address: string): boolean {
    if (address.length < 26 || address.length > 35) return false;
    const bytes = base58Decode(address);
    if (!bytes || bytes.length !== 25 || !BASE58_VERSIONS.has(bytes[0])) return false;
    const payload = bytes.subarray(0, 21);
    const checksum = sha256(sha256(payload)).subarray(0, 4);
    return checksum.equals(bytes.subarray(21));
}

// --- bech32 / bech32m (BIP-173, BIP-350) ---------------------------------------------

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
    let chk = 1;
    for (const v of values) {
        const top = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) {
            if ((top >>> i) & 1) chk ^= GENERATOR[i];
        }
    }
    return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
    out.push(0);
    for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
    return out;
}

function convertBits(data: number[], from: number, to: number): number[] | null {
    let acc = 0;
    let bits = 0;
    const out: number[] = [];
    const maxv = (1 << to) - 1;
    for (const value of data) {
        acc = (acc << from) | value;
        bits += from;
        while (bits >= to) {
            bits -= to;
            out.push((acc >>> bits) & maxv);
        }
    }
    // Decoding: leftover bits must be fewer than a group and all zero.
    if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
    return out;
}

/**
 * A SegWit address on mainnet (bc) or testnet (tb). Witness v0 must use the bech32
 * constant and a 20- or 32-byte program; v1+ must use bech32m (BIP-350), which is the
 * whole reason for bech32m: v0's checksum let a mutated v1 address through.
 */
export function isValidSegwitAddress(address: string): boolean {
    if (address.length > 90) return false;
    if (address !== address.toLowerCase() && address !== address.toUpperCase()) return false;
    const text = address.toLowerCase();
    const sep = text.lastIndexOf('1');
    if (sep < 1 || sep + 7 > text.length) return false;
    const hrp = text.slice(0, sep);
    if (hrp !== 'bc' && hrp !== 'tb') return false;

    const data: number[] = [];
    for (const ch of text.slice(sep + 1)) {
        const v = BECH32_CHARSET.indexOf(ch);
        if (v < 0) return false;
        data.push(v);
    }
    const check = polymod([...hrpExpand(hrp), ...data]);
    const witnessVersion = data[0];
    if (witnessVersion > 16) return false;
    const expected = witnessVersion === 0 ? BECH32_CONST : BECH32M_CONST;
    if (check !== expected) return false;

    const program = convertBits(data.slice(1, -6), 5, 8);
    if (!program || program.length < 2 || program.length > 40) return false;
    if (witnessVersion === 0 && program.length !== 20 && program.length !== 32) return false;
    return true;
}

export function isValidBtcAddress(address: string): boolean {
    return isValidBase58Check(address) || isValidSegwitAddress(address);
}
