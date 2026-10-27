/**
 * A pmtiles Source that reads through OSINT Copilot's IPC instead of fetch().
 *
 * fetch() cannot do this job here: the page is served from file://, where Chromium
 * answers neither Range requests nor cross-directory local reads, and the renderer is
 * sandboxed so it has no filesystem of its own. Every getBytes() is one round trip to a
 * descriptor main holds. pmtiles' own cache keeps the header and directories on this
 * side, so in steady state only tile bodies cross the boundary.
 */
import { EtagMismatch, type RangeResponse, type Source } from 'pmtiles';
import type { BasemapArchive, Host } from '../../host/types';

function abortError(): Error {
    // Leaflet and pmtiles both discriminate on err.name, not instanceof.
    return typeof DOMException === 'function'
        ? new DOMException('Aborted', 'AbortError')
        : Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

export class IpcPMTilesSource implements Source {
    constructor(
        private readonly archive: BasemapArchive,
        private readonly basemap: Host['basemap'],
    ) {}

    /** pmtiles' cache key. The resolved path is stable for the life of the handle. */
    getKey(): string {
        return this.archive.path;
    }

    async getBytes(
        offset: number,
        length: number,
        signal?: AbortSignal,
        etag?: string,
    ): Promise<RangeResponse> {
        if (signal?.aborted) throw abortError();
        const range = await this.basemap.read(this.archive.handleId, offset, length);
        // Leaflet aborts a tile the moment it leaves the viewport. The read has already
        // happened, so honouring the signal here is about not feeding a dead tile into
        // pmtiles' cache rather than saving the read.
        if (signal?.aborted) throw abortError();
        // pmtiles re-reads the header when a source reports a different etag. Without
        // this, replacing the archive mid-session serves tiles through a stale directory
        // and renders garbage instead of failing.
        if (etag !== undefined && etag !== range.etag) throw new EtagMismatch();
        return { data: range.data, etag: range.etag };
    }
}
