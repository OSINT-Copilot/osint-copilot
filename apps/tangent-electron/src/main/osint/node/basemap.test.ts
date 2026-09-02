import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as basemap from './basemap'
import type { BasemapArchive, BasemapProblem } from '../../../osint/host/types'

/**
 * The app builds with strict:false, where TypeScript does not narrow a discriminated
 * union on a boolean discriminant, so these read the fields off explicitly named shapes
 * instead of relying on `if (result.ok)`.
 */
type Failure = { ok: false; problem: BasemapProblem; path: string }
type Success = { ok: true; archive: BasemapArchive }
const asFailure = (r: unknown): Failure => r as Failure
const asSuccess = (r: unknown): Success => r as Success

/**
 * This is the whole security surface of the offline basemap: main reads byte ranges of a
 * file on the renderer's behalf, and a byte-range read of a caller-supplied path would be
 * an arbitrary-file-read primitive. These tests pin the constraints that stop it being
 * one.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-basemap-'))
const userData = path.join(dir, 'userData')

function writeArchive(name: string, body: Buffer | string, version = 3): string {
    const p = path.join(dir, name)
    const head = Buffer.alloc(8)
    Buffer.from('PMTiles', 'ascii').copy(head, 0)
    head[7] = version
    const payload = typeof body === 'string' ? Buffer.from(body) : body
    fs.writeFileSync(p, Buffer.concat([head, payload]))
    return p
}

/** A valid-looking archive: correct magic, correct version, past the minimum size. */
function validArchive(name = 'good.pmtiles'): string {
    return writeArchive(name, Buffer.alloc(200, 0x41))
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('offline basemap archives', () => {
    beforeEach(async () => {
        await basemap.closeAll()
        fs.rmSync(userData, { recursive: true, force: true })
        basemap.configureBasemap(userData, async () => null)
    })

    it('refuses a file that is not a PMTiles archive, whatever its name', async () => {
        const impostor = path.join(dir, 'secrets.pmtiles')
        fs.writeFileSync(impostor, 'ssh-ed25519 AAAA... definitely not a basemap')
        await basemap.__setRememberedPathForTests(impostor)
        const result = await basemap.open()
        expect(result.ok).toBe(false)
        expect(asFailure(result).problem).toBe('not-pmtiles')
    })

    it('refuses the right file type with the wrong extension', async () => {
        const wrongExt = writeArchive('archive.dat', Buffer.alloc(200))
        await basemap.__setRememberedPathForTests(wrongExt)
        const result = await basemap.open()
        expect(result.ok).toBe(false)
        expect(asFailure(result).problem).toBe('not-pmtiles')
    })

    it('refuses a PMTiles version it cannot read', async () => {
        const v2 = writeArchive('v2.pmtiles', Buffer.alloc(200), 2)
        await basemap.__setRememberedPathForTests(v2)
        const result = await basemap.open()
        expect(result.ok).toBe(false)
        expect(asFailure(result).problem).toBe('unsupported-version')
    })

    it('refuses a directory', async () => {
        const asDir = path.join(dir, 'notafile.pmtiles')
        fs.mkdirSync(asDir, { recursive: true })
        await basemap.__setRememberedPathForTests(asDir)
        const result = await basemap.open()
        expect(result.ok).toBe(false)
        // A directory can fail either check depending on the platform; both are refusals.
        expect(['not-a-file', 'unreadable']).toContain(asFailure(result).problem)
    })

    it('resolves symlinks before deciding, and reports the real path', async () => {
        const real = validArchive('real-target.pmtiles')
        const link = path.join(dir, 'link.pmtiles')
        fs.symlinkSync(real, link)
        await basemap.__setRememberedPathForTests(link)
        const result = await basemap.open()
        expect(result.ok).toBe(true)
        expect(asSuccess(result).archive.path).toBe(fs.realpathSync(real))
    })

    it('refuses a symlink that points at something that is not an archive', async () => {
        const secret = path.join(dir, 'id_ed25519')
        fs.writeFileSync(secret, 'PRIVATE KEY')
        const link = path.join(dir, 'sneaky.pmtiles')
        fs.symlinkSync(secret, link)
        await basemap.__setRememberedPathForTests(link)
        const result = await basemap.open()
        expect(result.ok).toBe(false)
    })

    it('reports not-configured when nothing has been chosen', async () => {
        const result = await basemap.open()
        expect(result.ok).toBe(false)
        expect(asFailure(result).problem).toBe('not-configured')
    })

    it('reads an exact, unpooled byte range', async () => {
        const p = validArchive('read.pmtiles')
        await basemap.__setRememberedPathForTests(p)
        const opened = await basemap.open()
        expect(opened.ok).toBe(true)
        const range = await basemap.read(asSuccess(opened).archive.handleId, 8, 16)
        // Exactly sized and byteOffset 0, or the renderer reads the wrong bytes after the
        // structured clone. A pooled Buffer would ship its whole 8 KiB slab.
        expect(range.data.byteLength).toBe(16)
        expect([...new Uint8Array(range.data)]).toEqual(Array(16).fill(0x41))
    })

    it('rejects nonsensical or oversized ranges', async () => {
        const p = validArchive('bounds.pmtiles')
        await basemap.__setRememberedPathForTests(p)
        const opened = await basemap.open()
        expect(opened.ok).toBe(true)
        const id = asSuccess(opened).archive.handleId

        await expect(basemap.read(id, -1, 10)).rejects.toThrow(RangeError)
        await expect(basemap.read(id, 0, 0)).rejects.toThrow(RangeError)
        await expect(basemap.read(id, 0, Number.NaN)).rejects.toThrow(RangeError)
        await expect(basemap.read(id, 0, 9 * 1024 * 1024)).rejects.toThrow(RangeError)
        await expect(basemap.read(id, 10_000_000, 10)).rejects.toThrow(RangeError)
    })

    it('refuses an unknown handle, and a handle after it is closed', async () => {
        await expect(basemap.read('not-a-handle', 0, 8)).rejects.toThrow(/No such basemap handle/)

        const p = validArchive('closed.pmtiles')
        await basemap.__setRememberedPathForTests(p)
        const opened = await basemap.open()
        expect(opened.ok).toBe(true)
        const handleId = asSuccess(opened).archive.handleId
        await basemap.close(handleId)
        await expect(basemap.read(handleId, 0, 8)).rejects.toThrow(/No such basemap handle/)
    })
})
