import { describe, it, expect, vi } from 'vitest';
import type { HrefFormedLink } from 'common/indexing/indexTypes';
import { linkPreviewSuppressedFor, PREVIEW_SUPPRESSED_MESSAGE } from '../integration/link-previews';
import { parseMarkdown } from '../../common/markdownModel/parser';

// NodeHandle only uses Workspace as a type; the real one would pull in the whole app.
vi.mock('../../app/model/Workspace', () => ({ default: class {} }));
import NodeHandle, { type HandleResult } from '../../app/model/NodeHandle';

/**
 * Hovering a link in Tangent (TLinkTooltip) or embedding one resolves it through a
 * NodeHandle, which for an external link asks main to fetch the target for a preview.
 * In the notes that hold investigated pages that fetch would tell the site someone is
 * looking, so it must not happen there, and must still happen everywhere else.
 */
function resolveExternal(from: string | undefined, href = 'https://target.example/profile/jdoe') {
    const link: HrefFormedLink = { form: 'raw', href, ...(from ? { from } : {}) };
    return resolveLink(link);
}

function resolveLink(link: HrefFormedLink) {
    const getUrlData = vi.fn(async (url: string) => ({
        url, title: 'Preview', siteName: 'target', description: '', images: [],
        mediaType: 'website', contentType: 'text/html', favicons: [],
    }));
    const workspace = {
        api: { links: { getUrlData } },
        // A raw link that names no file resolves to its href.
        directoryStore: { get: () => undefined },
        debug: {},
    };
    const values: HandleResult[] = [];
    const handle = new NodeHandle(workspace as any, (v) => values.push(v), null as any, link);
    handle.resolve();
    handle.pushChangesIfDirty();
    return { getUrlData, values };
}

describe('link previews in notes that hold investigated pages', () => {
    for (const from of [
        '/home/analyst/Case A/OSINTCopilot/Evidence/target-profile-1a2b3c4d.md',
        '/home/analyst/Case A/OSINTCopilot/Sources/target-profile-0123456789ab.md',
        'C:\\Cases\\Case A\\OSINTCopilot\\Evidence\\page.md',
        'OSINTCopilot/Sources/page.md',
    ]) {
        it(`does not fetch a preview for a link in ${from}`, async () => {
            const { getUrlData, values } = resolveExternal(from);
            await Promise.resolve();
            expect(getUrlData).not.toHaveBeenCalled();
            // An error value: the tooltip shows the plain URL, an embed shows nothing fetched.
            expect(values).toEqual([{ mediaType: 'error', message: PREVIEW_SUPPRESSED_MESSAGE }]);
        });
    }

    for (const from of [
        '/home/analyst/Case A/Notes/leads.md',
        '/home/analyst/Case A/OSINTCopilot/conversations/chat.md',
        '/home/analyst/Case A/Evidence/not-ours.md',
        undefined,
    ]) {
        it(`still fetches a preview for a link in ${from ?? 'a note with no path'}`, async () => {
            const { getUrlData, values } = resolveExternal(from);
            await vi.waitFor(() => expect(values).toHaveLength(1));
            expect(getUrlData).toHaveBeenCalledWith('https://target.example/profile/jdoe');
            expect(values[0]).toMatchObject({ mediaType: 'website', title: 'Preview' });
        });
    }

    it('matches the investigated-page folders as path segments, not as text', () => {
        expect(linkPreviewSuppressedFor('/x/OSINTCopilot/Evidence/a.md')).toBe(true);
        expect(linkPreviewSuppressedFor('/x/OSINTCopilot/Evidence/sub/a.md')).toBe(true);
        expect(linkPreviewSuppressedFor('/x/OSINTCopilot/EvidenceOld/a.md')).toBe(false);
        expect(linkPreviewSuppressedFor('/x/MyOSINTCopilot/Sources/a.md')).toBe(false);
        // The folder itself is not a note in it.
        expect(linkPreviewSuppressedFor('/x/OSINTCopilot/Evidence')).toBe(false);
        expect(linkPreviewSuppressedFor('')).toBe(false);
        expect(linkPreviewSuppressedFor(null)).toBe(false);
    });

    /**
     * The links the editor actually hovers come from parsing the note, so the note's path
     * has to survive parsing onto every kind of link, the bare URL most of all: it is how
     * the Sources note names the page, and alone on its line it embeds as soon as the
     * note opens, with no hover at all.
     */
    function linksParsedFrom(filepath: string, markdown: string): HrefFormedLink[] {
        const { lines } = parseMarkdown(markdown, { filepath });
        return lines.flatMap((line) => line.content.ops)
            .map((op) => op.attributes?.t_link as HrefFormedLink | undefined)
            .filter((link): link is HrefFormedLink => !!link);
    }

    const note = [
        '# target.example/profile/jdoe',
        '',
        'Source: https://target.example/profile/jdoe',
        '',
        'https://target.example/alone-on-its-line',
        '',
        'See [the page](https://target.example/md).',
        '',
    ].join('\n');

    it('does not fetch a preview for any link parsed from a Sources note, bare URLs included', async () => {
        const path = '/home/analyst/Case A/OSINTCopilot/Sources/target-profile-0123456789ab.md';
        const links = linksParsedFrom(path, note);
        const raw = links.filter((l) => l.form === 'raw').map((l) => l.href);
        expect(raw).toEqual(['https://target.example/profile/jdoe', 'https://target.example/alone-on-its-line']);
        expect(links.some((l) => l.form === 'md')).toBe(true);
        for (const link of links) {
            expect(link.from).toBe(path);
            const { getUrlData } = resolveLink(link);
            await Promise.resolve();
            expect(getUrlData).not.toHaveBeenCalled();
        }
    });

    it('still fetches a preview for a bare URL parsed from a note elsewhere', async () => {
        const [link] = linksParsedFrom('/home/analyst/Case A/Notes/leads.md', 'Source: https://target.example/profile/jdoe');
        const { getUrlData, values } = resolveLink(link);
        await vi.waitFor(() => expect(values).toHaveLength(1));
        expect(getUrlData).toHaveBeenCalledWith('https://target.example/profile/jdoe');
    });
});
