/**
 * `[a-z0-9-]`, at most 60 characters, no leading or trailing dash. Empty when nothing is
 * left. Pure, so main's evidence names and the renderer's Sources notes share it.
 */
export function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, 60)
        .replace(/-+$/, '');
}
