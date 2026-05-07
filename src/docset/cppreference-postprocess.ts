// Install-time HTML pre-processing pass for cppreference's MediaWiki
// output. H-4 in docs/CODE-REVIEW-2026-05-07.md — strips the chrome
// that the rendering pipeline can't usefully display offline:
//
//   - "Edit on cppreference" anchors (`<a class="t-cppreference-source">`,
//     `t-navbar`, etc.) — these link to the wiki edit endpoint, which
//     serves a 404 to logged-out clicks, so they read as broken
//     external links.
//   - Inline analytics / `mw.config.set(…)` snippets remaining outside
//     `<script>` tags — `<script>` is stripped by the runtime
//     rewriter, but stray `_gaq.push(…)` style calls inside `<noscript>`
//     containers are NOT.
//
// Runs once at install time so the on-disk HTML is what gets re-served
// at every render with no per-render cost. Failures degrade silently —
// a single unparseable file shouldn't fail the install.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Parser } from 'htmlparser2';
import { escapeText } from '../util/html-escape.js';
import { VOID_TAGS, serializeAttrs } from '../webview-host/html-serializer.js';

const STRIP_CLASS_FRAGMENTS: ReadonlyArray<string> = [
    // Top-of-page MediaWiki nav (Page/Discussion/View source/History).
    't-navbar',
    // The "edit on cppreference.com" link rendered next to most pages.
    't-cppreference-source',
    // MediaWiki sidebar / footer chrome that has no place offline.
    'noprint',
    'mw-jump-link',
    'printfooter'
];

function shouldStrip(attribs: Record<string, string>): boolean {
    const cls = attribs['class'];
    if (!cls) return false;
    // Class lists are space-separated; prefix-tolerant match per the
    // MediaWiki convention of compound class attributes.
    const tokens = cls.split(/\s+/);
    for (const fragment of STRIP_CLASS_FRAGMENTS) {
        if (tokens.includes(fragment)) return true;
    }
    return false;
}

/**
 * Pure: rewrite a single cppreference HTML file with the chrome stripped.
 * Exported for unit tests. Failures (parse errors) return the input
 * unchanged so a malformed file never breaks the install.
 */
export function stripCppreferenceChrome(input: string): string {
    try {
        const out: string[] = [];
        let skipDepth = 0;
        const parser = new Parser(
            {
                onprocessinginstruction(_name: string, data: string) {
                    if (skipDepth > 0) return;
                    out.push('<' + data + '>');
                },
                onopentag(name, attribs) {
                    if (skipDepth > 0) {
                        skipDepth++;
                        return;
                    }
                    if (shouldStrip(attribs)) {
                        skipDepth = 1;
                        return;
                    }
                    out.push('<' + name + serializeAttrs(attribs, name) + '>');
                },
                ontext(text) {
                    if (skipDepth > 0) return;
                    out.push(escapeText(text));
                },
                onclosetag(name) {
                    if (skipDepth > 0) {
                        skipDepth--;
                        return;
                    }
                    if (VOID_TAGS.has(name)) return;
                    out.push('</' + name + '>');
                },
                oncomment(data) {
                    if (skipDepth > 0) return;
                    out.push('<!--' + data + '-->');
                }
            },
            { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
        );
        parser.write(input);
        parser.end();
        return out.join('');
    } catch {
        return input;
    }
}

/**
 * Walk every `*.html` file under `documentsDir` and rewrite it with
 * `stripCppreferenceChrome`. Errors on individual files are swallowed
 * (the install path must remain robust).
 */
export async function preprocessCppreferenceHtml(
    documentsDir: string
): Promise<{ scanned: number; rewritten: number }> {
    let scanned = 0;
    let rewritten = 0;
    const stack: string[] = [documentsDir];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: import('node:fs').Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                stack.push(path.join(dir, entry.name));
                continue;
            }
            const p = path.join(dir, entry.name);
            if (!entry.isFile() || !p.endsWith('.html')) continue;
            scanned++;
            try {
                const html = await readFile(p, 'utf8');
                const next = stripCppreferenceChrome(html);
                if (next !== html) {
                    await writeFile(p, next);
                    rewritten++;
                }
            } catch {
                // skip — single-file IO failure must not fail the install
            }
        }
    }
    return { scanned, rewritten };
}
