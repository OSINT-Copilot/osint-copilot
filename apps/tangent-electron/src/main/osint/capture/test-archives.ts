/**
 * Test helper: MHTML archives shaped like the ones chrome.pageCapture writes (see
 * fixtures/blink-page.mhtml for a whole one), around HTML a test chooses.
 */

/** Quoted-printable as Blink writes it: '=' and non-ASCII escaped, 76-column soft breaks. */
function quotedPrintable(text: string): string {
    const bytes = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8');
    const lines: string[] = [];
    let line = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0x0d && bytes[i + 1] === 0x0a) {
            lines.push(line);
            line = '';
            i++;
            continue;
        }
        const token = b === 0x3d || b < 0x20 || b > 0x7e ? '=' + b.toString(16).toUpperCase().padStart(2, '0') : String.fromCharCode(b);
        if (line.length + token.length > 75) {
            lines.push(line + '=');
            line = '';
        }
        line += token;
    }
    lines.push(line);
    return lines.join('\r\n');
}

export function blinkArchive(opts: { url?: string | null; html: string; boundary?: string }): string {
    const boundary = opts.boundary ?? '----MultipartBoundary--TestBoundary0123456789----';
    const top = [
        'From: <Saved by Blink>',
        ...(opts.url ? [`Snapshot-Content-Location: ${opts.url}`] : []),
        'Subject: test',
        'Date: Fri, 18 Sep 2026 10:00:00 -0000',
        'MIME-Version: 1.0',
        'Content-Type: multipart/related;',
        '\ttype="text/html";',
        `\tboundary="${boundary}"`,
        '',
        '',
    ];
    return [
        ...top,
        `--${boundary}`,
        'Content-Type: text/html',
        'Content-Transfer-Encoding: quoted-printable',
        ...(opts.url ? [`Content-Location: ${opts.url}`] : []),
        '',
        quotedPrintable(opts.html),
        `--${boundary}--`,
        '',
    ].join('\r\n');
}
