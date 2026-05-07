import { escapeAttr } from '../util/html-escape.js';

export const VOID_TAGS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr'
]);

export type AttrFilter = (k: string, v: string, tag: string) => string | null;

export function serializeAttrs(
    attribs: Record<string, string>,
    tag: string,
    filter?: AttrFilter
): string {
    let out = '';
    for (const [k, v] of Object.entries(attribs)) {
        const resolved = filter ? filter(k, v, tag) : v;
        if (resolved === null) continue;
        out += resolved === '' ? ` ${k}` : ` ${k}="${escapeAttr(resolved)}"`;
    }
    return out;
}
