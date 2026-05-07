// Server-side syntax highlighting for hover tooltip snippets.
//
// The hover popup (vscode.MarkdownString with supportHtml:true) doesn't load
// our webview CSS, so cppreference's GeSHi token classes (.kw1, .sy1, …) are
// invisible — all code appears in the plain foreground color.
//
// This module:
//   1. Scans the synopsis HTML for `<span class="mw-geshi …">` blocks.
//   2. Strips the GeSHi child spans and collects their decoded text.
//   3. Re-tokenizes with highlight.js (cpp grammar, same library as the panel).
//   4. Converts hljs class-based spans to inline `style="color:…"` spans so
//      the colors render without any external stylesheet.
//
// Color values use CSS var() with Dark+ hex fallbacks:
//   – The var() names are VSCode theme variables available in the hover widget.
//   – The hex literals match Dark+ so un-themed contexts still look correct.

import { Parser } from 'htmlparser2';
import hljs from 'highlight.js/lib/core';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import { escapeText, escapeAttr } from '../util/html-escape.js';

hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', c);

// Maps hljs token class → inline color.  Empty string = inherit foreground.
const HLJS_COLORS: Readonly<Record<string, string>> = {
    'hljs-keyword': 'var(--vscode-symbolIcon-keywordForeground,#569cd6)',
    'hljs-type': 'var(--vscode-symbolIcon-classForeground,#4ec9b0)',
    'hljs-built_in': 'var(--vscode-symbolIcon-classForeground,#4ec9b0)',
    'hljs-literal': 'var(--vscode-symbolIcon-keywordForeground,#569cd6)',
    'hljs-string': '#ce9178',
    'hljs-number': '#b5cea8',
    'hljs-comment': '#6a9955',
    'hljs-meta': '#c586c0',
    'hljs-variable': 'var(--vscode-symbolIcon-variableForeground,#9cdcfe)',
    'hljs-title': 'var(--vscode-symbolIcon-methodForeground,#dcdcaa)',
    'hljs-attr': 'var(--vscode-symbolIcon-variableForeground,#9cdcfe)',
    'hljs-punctuation': '',  // inherit — punctuation tracks foreground
    'hljs-params': '',  // inherit
};

/**
 * Replace `<span class="hljs-*">` tags in hljs output with inline
 * `style="color:…"` equivalents. The source HTML is already well-formed
 * hljs output so a regex substitution on the open-tag pattern is safe.
 */
function hljsToInlineStyles(hljsHtml: string): string {
    return hljsHtml.replace(/<span class="([^"]+)">/g, (_m, cls: string) => {
        const full = cls.trim();
        // Try the full compound class first (e.g. "hljs-title function_").
        const direct = HLJS_COLORS[full];
        if (direct !== undefined) {
            return direct ? `<span style="color:${direct}">` : '<span>';
        }
        // Fall back to the first matching individual token.
        for (const tok of full.split(/\s+/)) {
            const color = HLJS_COLORS[tok];
            if (color !== undefined) {
                return color ? `<span style="color:${color}">` : '<span>';
            }
        }
        return '<span>';
    });
}

function isGeshiClass(cls: string): boolean {
    return /\bmw-geshi\b/.test(cls) || /\bsource-(?:cpp|c)\b/.test(cls);
}

const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);


/**
 * Walk the synopsis HTML, replacing every `<span class="mw-geshi …">…</span>`
 * block with inline-highlighted equivalent HTML. All other markup is passed
 * through unchanged.
 *
 * Safe to call on an empty string — returns '' immediately.
 */
export function highlightSynopsisHtml(synopsisHtml: string): string {
    if (!synopsisHtml) return synopsisHtml;

    const out: string[] = [];
    // Depth of span nesting inside the current GeSHi block (0 = outside).
    let geshiDepth = 0;
    // Plain-text C++ code accumulated from inside the GeSHi block.
    let geshiText = '';
    // Language hint from the GeSHi class ("cpp" or "c").
    let geshiLang = 'cpp';

    function flushGeshi(): void {
        const code = geshiText.trim();
        geshiText = '';
        if (!code) return;
        let highlighted: string;
        try {
            highlighted = hljs.highlight(code, {
                language: geshiLang,
                ignoreIllegals: true
            }).value;
        } catch {
            out.push(escapeText(code));
            return;
        }
        out.push(hljsToInlineStyles(highlighted));
    }

    const parser = new Parser(
        {
            onopentag(name, attribs) {
                if (geshiDepth > 0) {
                    // Inside a GeSHi block — track span nesting, suppress all tags.
                    if (name === 'span') geshiDepth++;
                    return;
                }
                if (name === 'span' && isGeshiClass(attribs['class'] ?? '')) {
                    // Determine language from the class list.
                    geshiLang = /\bsource-c\b(?!pp)/.test(attribs['class'] ?? '') ? 'c' : 'cpp';
                    geshiDepth = 1;
                    return;
                }
                // Emit tag normally.
                let tag = `<${name}`;
                for (const [k, v] of Object.entries(attribs)) {
                    tag += v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`;
                }
                tag += '>';
                out.push(tag);
            },

            ontext(text) {
                if (geshiDepth > 0) {
                    geshiText += text;
                    return;
                }
                out.push(escapeText(text));
            },

            onclosetag(name, isImplied) {
                if (isImplied) return;
                if (geshiDepth > 0) {
                    if (name === 'span') {
                        geshiDepth--;
                        if (geshiDepth === 0) {
                            flushGeshi();
                        }
                    }
                    // Suppress all other closing tags inside the GeSHi block.
                    return;
                }
                if (VOID_TAGS.has(name)) return;
                out.push(`</${name}>`);
            }
        },
        { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
    );

    parser.write(synopsisHtml);
    parser.end();

    return out.join('');
}
