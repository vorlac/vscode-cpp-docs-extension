// Re-highlight cppreference's offline code blocks with highlight.js.
//
// cppreference's static HTML carries pre-tokenized markup from GeSHi
// (.kw1, .sy1, .me2, ...). Our CSS already targets those classes, but
// GeSHi's classification is coarse — most operators and unqualified
// identifiers render as plain text.
//
// Re-tokenizing with highlight.js (cpp / c grammars) produces the
// .hljs-keyword / .hljs-string / .hljs-comment / ... class taxonomy
// that template.ts maps to the active VSCode theme colors.
//
// Only block-level code is re-highlighted. Inline mw-geshi spans
// containing a single token are left alone.

import hljs from 'highlight.js/lib/core';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';

hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', c);

const CPP_LANG_HINTS: ReadonlyArray<string> = [
    'cpp',
    'source-cpp',
    'language-cpp',
    'lang-cpp'
];
const C_LANG_HINTS: ReadonlyArray<string> = [
    'source-c',
    'language-c',
    'lang-c'
];

function detectLanguage(el: Element): 'cpp' | 'c' | undefined {
    const cls = el.className;
    if (typeof cls !== 'string') return undefined;
    // C++ wins on conflict — cppreference's C pages can also surface
    // source-c for short snippets; prefer C++ rather than mis-highlighting.
    for (const hint of CPP_LANG_HINTS) {
        if (cls.split(/\s+/).includes(hint)) return 'cpp';
    }
    for (const hint of C_LANG_HINTS) {
        if (cls.split(/\s+/).includes(hint)) return 'c';
    }
    return undefined;
}

function isBlockCode(el: Element): boolean {
    const text = (el.textContent ?? '').trim();
    if (text.length === 0) return false;
    if (text.includes('\n')) return true;
    // Single-line examples: must have whitespace AND enough content to be
    // a real declaration. Prevents re-highlighting inline keyword spans.
    return text.length > 30 && /\s/.test(text);
}

function findWrapper(el: Element): Element {
    const wrapper = el.closest('.mw-geshi');
    return wrapper ?? el;
}

function inferFromChildren(el: Element): 'cpp' | 'c' | undefined {
    for (const child of Array.from(el.children)) {
        const lang = detectLanguage(child);
        if (lang) return lang;
    }
    return undefined;
}

/**
 * Re-tokenize every cppreference code block under `root` (defaults to
 * `document.body`) with highlight.js. Idempotent: blocks marked
 * `data-cppref-hljs` are skipped on subsequent runs.
 */
export function applySyntaxHighlight(root?: ParentNode): void {
    const scope: ParentNode = root ?? document.body;
    const candidates = scope.querySelectorAll<HTMLElement>(
        'div.mw-geshi, pre.source-cpp, pre.source-c'
    );
    for (const el of Array.from(candidates)) {
        if (el.dataset['cpprefHljs'] === '1') continue;
        if (!isBlockCode(el)) continue;
        const lang = detectLanguage(el) ?? inferFromChildren(el);
        if (!lang) continue;
        const code = (el.textContent ?? '').replace(/ /g, ' ');
        if (code.trim().length === 0) continue;
        let highlighted: string;
        try {
            highlighted = hljs.highlight(code, {
                language: lang,
                ignoreIllegals: true
            }).value;
        } catch {
            continue;
        }
        const pre = document.createElement('pre');
        pre.className = 'cppref-hljs-pre';
        pre.dataset['cpprefHljs'] = '1';
        const codeEl = document.createElement('code');
        codeEl.className = `hljs language-${lang}`;
        codeEl.innerHTML = highlighted;
        pre.appendChild(codeEl);
        findWrapper(el).replaceWith(pre);
    }
}
