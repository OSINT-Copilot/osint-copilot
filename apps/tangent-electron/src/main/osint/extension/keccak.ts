/**
 * Keccak-256 and the EIP-55 address checksum.
 *
 * Ethereum hashes with the original Keccak submission, whose padding byte is 0x01. Node's
 * crypto offers only FIPS-202 SHA3-256, which pads with 0x06 and so gives different
 * digests for every input -- it cannot stand in. This is a small, unoptimised
 * Keccak-f[1600] over BigInt lanes: it hashes a 40-character address, a few hundred bytes
 * per bundle, so clarity wins over speed.
 */

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS: readonly bigint[] = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets, indexed x + 5y. */
const ROTATIONS: readonly number[] = [
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
];

function rotl(lane: bigint, n: number): bigint {
    if (n === 0) return lane;
    const s = BigInt(n);
    return ((lane << s) | (lane >> (64n - s))) & MASK;
}

function keccakF(a: bigint[]): void {
    const c = new Array<bigint>(5);
    const b = new Array<bigint>(25);
    for (let round = 0; round < 24; round++) {
        // theta
        for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
        for (let x = 0; x < 5; x++) {
            const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
            for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
        }
        // rho and pi
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) {
                b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROTATIONS[x + 5 * y]);
            }
        }
        // chi
        for (let y = 0; y < 25; y += 5) {
            for (let x = 0; x < 5; x++) {
                a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
            }
        }
        // iota
        a[0] ^= ROUND_CONSTANTS[round];
    }
}

const RATE_BYTES = 136; // 1600 - 2*256 bits

export function keccak256(input: Buffer | string): Buffer {
    const data = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    // Original Keccak padding: 0x01 ... 0x80 (the two may share a byte).
    const padded = Buffer.alloc((Math.floor(data.length / RATE_BYTES) + 1) * RATE_BYTES);
    data.copy(padded);
    padded[data.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;

    const state = new Array<bigint>(25).fill(0n);
    for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
        for (let i = 0; i < RATE_BYTES / 8; i++) {
            state[i] ^= padded.readBigUInt64LE(offset + i * 8);
        }
        keccakF(state);
    }
    const out = Buffer.alloc(32);
    for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], i * 8);
    return out;
}

/** The EIP-55 mixed-case form of a 0x-prefixed, 40-hex-digit address. */
export function toEip55(address: string): string {
    const hex = address.slice(2).toLowerCase();
    const hash = keccak256(hex).toString('hex');
    let out = '0x';
    for (let i = 0; i < 40; i++) {
        out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
    }
    return out;
}

/**
 * An all-lowercase or all-uppercase address carries no checksum and is accepted as-is;
 * a mixed-case one claims a checksum, so it must match.
 */
export function isValidEthAddress(address: string): boolean {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
    const body = address.slice(2);
    if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
    return toEip55(address) === address;
}
