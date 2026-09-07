import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stubbed at the module the service actually imports, which is the shim's requestUrl --
// the single door onto the main process, where net-guard lives. Nothing here should ever
// reach it for a picture that is already in the vault, and several tests assert exactly
// that rather than merely asserting the result came back empty.
vi.mock('../obsidian-shim/core/request-url', () => ({
    requestUrl: vi.fn(),
}));

import { requestUrl } from '../obsidian-shim/core/request-url';
import { createTestAppAsync } from '../obsidian-shim/testing/create-test-app';
import { resolveEntityImage } from '../services/entity-image-service';

const FOLDER = 'OSINTCopilot/Evidence';

/** A real PNG: the signature is what detectImageType actually looks at. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 1, 1, 1, 1, 1, 1]);
const HTML = new TextEncoder().encode('<!doctype html><html><body>not an image at all</body></html>');
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function respond(bytes: Uint8Array, status = 200) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    vi.mocked(requestUrl).mockResolvedValue({
        status, headers: {}, arrayBuffer: buffer as ArrayBuffer, text: '', json: null,
    });
}

async function hostWith(files: Record<string, string> = {}) {
    const app = await createTestAppAsync({ files });
    return { host: { app: app as never, folder: FOLDER }, app };
}

beforeEach(() => vi.mocked(requestUrl).mockReset());

describe('a picture already in the vault', () => {
    it('is adopted without touching the network', async () => {
        const { host } = await hostWith({ 'OSINTCopilot/Evidence/ada.png': 'x' });
        const result = await resolveEntityImage(host, { image: 'OSINTCopilot/Evidence/ada.png' });

        expect(result.outcome).toEqual({ kind: 'existing', path: 'OSINTCopilot/Evidence/ada.png' });
        expect(result.properties.image).toBe('OSINTCopilot/Evidence/ada.png');
        // The whole point of offering a vault path: it works with no connection at all.
        expect(requestUrl).not.toHaveBeenCalled();
    });

    it('wins over a URL, so a model that supplies both causes no download', async () => {
        const { host } = await hostWith({ 'OSINTCopilot/Evidence/ada.png': 'x' });
        const result = await resolveEntityImage(host, {
            image: 'OSINTCopilot/Evidence/ada.png',
            image_url: 'https://example.org/ada.png',
        });

        expect(result.outcome.kind).toBe('existing');
        expect(result.properties.image_url).toBeUndefined();
        expect(requestUrl).not.toHaveBeenCalled();
    });

    it('is dropped rather than kept when the file is not there', async () => {
        const { host } = await hostWith();
        const result = await resolveEntityImage(host, { image: 'Evidence/missing.png' });

        // A path that resolves to nothing would leave the tile pointing at nothing.
        expect(result.properties.image).toBeUndefined();
        expect(result.outcome.kind).toBe('none');
    });
});

describe('downloading a picture the model named', () => {
    it('stores it in the vault and points the entity at the file', async () => {
        respond(PNG);
        const { host, app } = await hostWith();
        const result = await resolveEntityImage(host, { image_url: 'https://example.org/a.png' });

        expect(result.outcome.kind).toBe('downloaded');
        const path = String(result.properties.image);
        expect(path.startsWith(`${FOLDER}/`)).toBe(true);
        expect(app.vault.getAbstractFileByPath(path)).toBeTruthy();
        // Consumed: `image` now holds a path, so the URL has nothing left to say.
        expect(result.properties.image_url).toBeUndefined();
    });

    it('names the file from a hash of the URL, never from the URL text', async () => {
        respond(PNG);
        const { host } = await hostWith();
        const result = await resolveEntityImage(host, {
            image_url: 'https://example.org/../../etc/passwd%00.png?x=<script>',
        });

        const path = String(result.properties.image);
        expect(path.startsWith(`${FOLDER}/`)).toBe(true);
        // No traversal, no attacker text, nothing but the sanitised host and a hash.
        expect(path).not.toContain('..');
        expect(path).not.toContain('<');
        expect(path).not.toContain('passwd');
    });

    it('accepts a URL left in the image field instead of image_url', async () => {
        respond(GIF);
        const { host } = await hostWith();
        const result = await resolveEntityImage(host, { image: 'https://example.org/a.gif' });
        expect(result.outcome.kind).toBe('downloaded');
    });

    it('reuses the stored copy on a second run, so re-extraction is idempotent', async () => {
        respond(PNG);
        const { host, app } = await hostWith();
        const first = await resolveEntityImage(host, { image_url: 'https://example.org/a.png' });
        const second = await resolveEntityImage(host, { image_url: 'https://example.org/a.png' });

        expect(second.properties.image).toBe(first.properties.image);
        expect(app.storage.paths().filter((p) => p.startsWith(`${FOLDER}/`))).toHaveLength(1);
    });
});

describe('what it refuses', () => {
    const refuses = async (bytes: Uint8Array, status = 200) => {
        respond(bytes, status);
        const { host, app } = await hostWith();
        const result = await resolveEntityImage(host, { image_url: 'https://example.org/a.png' });
        return { result, written: app.storage.paths().filter((p) => p.startsWith(`${FOLDER}/`)) };
    };

    it('an HTML page served where an image was promised', async () => {
        // The common failure, not an exotic one: the type comes from magic bytes, so a
        // 200 OK page claiming image/png is still not an image.
        const { result, written } = await refuses(HTML);
        expect(result.outcome.kind).toBe('failed');
        expect(result.properties.image).toBeUndefined();
        expect(written).toHaveLength(0);
    });

    it('an SVG, which is XML that can carry script', async () => {
        const { result, written } = await refuses(SVG);
        expect(result.outcome.kind).toBe('failed');
        expect(written).toHaveLength(0);
    });

    it('anything over the size cap', async () => {
        const huge = new Uint8Array(4 * 1024 * 1024 + 1);
        huge.set(PNG.subarray(0, 8));
        const { result, written } = await refuses(huge);
        expect(result.outcome.kind).toBe('failed');
        expect(written).toHaveLength(0);
    });

    it('an error response', async () => {
        const { result } = await refuses(PNG, 404);
        expect(result.outcome.kind).toBe('failed');
    });

    it('a non-http scheme, without asking the network about it', async () => {
        const { host } = await hostWith();
        const result = await resolveEntityImage(host, { image_url: 'file:///etc/passwd' });

        expect(result.outcome.kind).toBe('failed');
        expect(requestUrl).not.toHaveBeenCalled();
    });

    it('keeps image_url after a failure, so the attempt is recorded and retryable', async () => {
        const { result } = await refuses(HTML);
        expect(result.properties.image_url).toBe('https://example.org/a.png');
    });
});

describe('failure never escapes', () => {
    it('resolves rather than rejects when the response is unusable', async () => {
        /*
         * A malformed response rather than a mock that throws. Vitest attributes any
         * exception raised INSIDE a spy to the test even when the code under test catches
         * it, so a throwing mock cannot express "...and we handled that". Reading
         * .byteLength off the absent buffer raises inside downloadImage instead, which is
         * the same catch a transport error takes.
         *
         * The property under test is the one that matters in a batch: one unreachable
         * host must cost its own entity a picture and nothing else.
         */
        vi.mocked(requestUrl).mockResolvedValue({
            status: 200, headers: {}, text: '', json: null,
        } as never);
        const { host } = await hostWith();
        const result = await resolveEntityImage(host, { image_url: 'https://example.org/a.png' });

        expect(result.outcome.kind).toBe('failed');
        expect(result.properties.image).toBeUndefined();
        // The URL survives, so the attempt is recorded and can be retried.
        expect(result.properties.image_url).toBe('https://example.org/a.png');
    });

    it('leaves an entity with no picture completely alone', async () => {
        const { host } = await hostWith();
        const result = await resolveEntityImage(host, { full_name: 'A. Ivanov' });

        expect(result.properties).toEqual({ full_name: 'A. Ivanov' });
        expect(result.outcome.kind).toBe('none');
        expect(requestUrl).not.toHaveBeenCalled();
    });
});
