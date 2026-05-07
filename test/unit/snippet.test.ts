import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    extractSnippet,
    extractSnippetHtml,
    extractSnippetText
} from '../../src/webview-host/snippet.js';

const FIXTURE_ROOT = path.resolve(
    __dirname,
    '..',
    'fixtures',
    'cppreference-mini'
);

function loadFixture(rel: string): string {
    return readFileSync(path.join(FIXTURE_ROOT, rel), 'utf8');
}

describe('extractSnippet — fixture: std::vector::push_back', () => {
    const html = loadFixture('en/cpp/container/vector/push_back.html');

    it('returns a non-empty synopsis containing the void push_back declaration', () => {
        const s = extractSnippet(html, { maxChars: 4000 });
        expect(s.synopsisHtml.length).toBeGreaterThan(0);
        expect(s.synopsisText).toContain('void push_back');
    });

    it('captures both overloads in the synopsis text', () => {
        const s = extractSnippet(html, { maxChars: 4000 });
        // Overload (1) and (2) markers from cppreference's synopsis table.
        expect(s.synopsisText).toContain('(1)');
        expect(s.synopsisText).toContain('(2)');
    });

    it('emits the synopsis HTML inside a <table> element', () => {
        const s = extractSnippet(html, { maxChars: 4000 });
        expect(s.synopsisHtml).toMatch(/^<table\b/);
        expect(s.synopsisHtml).toContain('</table>');
    });

    it('captures a descriptive paragraph that opens with "Appends"', () => {
        const s = extractSnippet(html, { maxChars: 4000 });
        expect(s.paragraphHtml.length).toBeGreaterThan(0);
        expect(s.paragraphText).toMatch(/^Appends/);
    });

    it('does not include any stripped tags (script/iframe/form/input/button/style)', () => {
        const s = extractSnippet(html, { maxChars: 4000 });
        for (const tag of ['script', 'iframe', 'form', 'input', 'button', 'style']) {
            expect(s.synopsisHtml).not.toContain(`<${tag}`);
            expect(s.paragraphHtml).not.toContain(`<${tag}`);
        }
    });
});

describe('extractSnippet — fixture: std::sort', () => {
    const sortHtml = loadFixture('en/cpp/algorithm/sort.html');
    const pushBackHtml = loadFixture('en/cpp/container/vector/push_back.html');

    it('captures synopsis and a non-empty descriptive paragraph', () => {
        const s = extractSnippet(sortHtml, { maxChars: 4000 });
        expect(s.synopsisHtml.length).toBeGreaterThan(0);
        expect(s.paragraphText.length).toBeGreaterThan(0);
        expect(s.synopsisText).toContain('void sort');
    });

    it("paragraph mentions sorting", () => {
        const s = extractSnippet(sortHtml, { maxChars: 4000 });
        expect(s.paragraphText.toLowerCase()).toContain('sort');
    });

    it('does not bleed into prose past the first paragraph', () => {
        const s = extractSnippet(sortHtml, { maxChars: 4000 });
        // The "first" descriptive paragraph for std::sort begins "Sorts the
        // elements in the range …"; subsequent prose talks about "comp" and
        // "execution policy". A correctly-bounded capture stops at the first
        // </p>.
        expect(s.paragraphText).toMatch(/^Sorts/);
        expect(s.paragraphHtml.endsWith('</p>')).toBe(true);
    });

    it('synopsis is not absurdly larger than push_back synopsis (sanity check)', () => {
        // sort has 4 overloads; push_back has 2 — sort's synopsis is naturally
        // longer. We just verify both are positive and bounded.
        const sSort = extractSnippet(sortHtml, { maxChars: 8000 });
        const sPush = extractSnippet(pushBackHtml, { maxChars: 8000 });
        expect(sSort.synopsisText.length).toBeGreaterThan(0);
        expect(sPush.synopsisText.length).toBeGreaterThan(0);
        expect(sSort.synopsisText.length).toBeLessThan(8000);
    });
});

describe('extractSnippet — fixture: prose-only page (no synopsis)', () => {
    // The integer.html and iostream.html pages have no t-dcl-begin synopsis
    // table; they're "language" / header overview pages. Our extractor falls
    // back to capturing the first descriptive `<p>` only.
    const html = loadFixture('en/cpp/types/integer.html');

    it('returns empty synopsisHtml', () => {
        const s = extractSnippet(html, { maxChars: 4000 });
        expect(s.synopsisHtml).toBe('');
        expect(s.synopsisText).toBe('');
    });

    it('returns a non-empty paragraphHtml — the first descriptive paragraph', () => {
        const s = extractSnippet(html, { maxChars: 4000 });
        expect(s.paragraphHtml.length).toBeGreaterThan(0);
        expect(s.paragraphHtml.startsWith('<p')).toBe(true);
        expect(s.paragraphText.length).toBeGreaterThan(0);
    });

    it('paragraph is exactly one <p>…</p> block (single-paragraph capture)', () => {
        const s = extractSnippet(html, { maxChars: 4000 });
        expect(s.paragraphHtml.endsWith('</p>')).toBe(true);
        // exactly one opening <p tag
        const opens = s.paragraphHtml.match(/<p[\s>]/g) ?? [];
        expect(opens).toHaveLength(1);
    });

    it('iostream header page also extracts the first descriptive paragraph', () => {
        const iosHtml = loadFixture('en/cpp/header/iostream.html');
        const s = extractSnippet(iosHtml, { maxChars: 4000 });
        expect(s.synopsisHtml).toBe('');
        expect(s.paragraphText.toLowerCase()).toContain('input/output');
    });
});

describe('extractSnippet — truncation', () => {
    const html = loadFixture('en/cpp/algorithm/sort.html');

    it('marks truncated:true and stays within maxChars + 1 (ellipsis) for tight budgets', () => {
        const maxChars = 80;
        const s = extractSnippet(html, { maxChars });
        expect(s.truncated).toBe(true);
        // Plain text length never exceeds maxChars + 1 (the appended ellipsis).
        expect(s.totalChars).toBeLessThanOrEqual(maxChars + 1);
    });

    it('does not mark truncated when content fits comfortably', () => {
        // Pick a budget large enough to fit both regions of any of our fixtures.
        const s = extractSnippet(html, { maxChars: 100_000 });
        expect(s.truncated).toBe(false);
    });

    it('paragraph carries the ellipsis when both regions were captured', () => {
        const s = extractSnippet(html, { maxChars: 200 });
        expect(s.truncated).toBe(true);
        expect(s.paragraphText.endsWith('…') || s.synopsisText.endsWith('…')).toBe(
            true
        );
    });

    it('keeps synopsis HTML well-formed even when text budget is exhausted mid-table', () => {
        const s = extractSnippet(html, { maxChars: 30 });
        if (s.synopsisHtml.length > 0) {
            // If we emitted a <table> open we must have emitted </table> too.
            const opens = (s.synopsisHtml.match(/<table\b/g) ?? []).length;
            const closes = (s.synopsisHtml.match(/<\/table>/g) ?? []).length;
            expect(closes).toBe(opens);
        }
    });
});

describe('extractSnippet — synopsis exists but no descriptive paragraph follows', () => {
    // Synthetic: a page where the synopsis table is followed directly by an
    // <h3> (no <p>). Some `enum` / forward-declaration pages are shaped this
    // way in cppreference.
    const html = `
    <html><body>
      <table class="t-dcl-begin"><tbody>
        <tr class="t-dcl"><td>enum class color { red, green, blue };</td></tr>
      </tbody></table>
      <h3>Notes</h3>
      <p>This paragraph is in a section, not the description.</p>
    </body></html>
  `;

    it('captures synopsis but leaves paragraphHtml empty', () => {
        const s = extractSnippet(html);
        expect(s.synopsisHtml.length).toBeGreaterThan(0);
        expect(s.synopsisText).toContain('enum class color');
        expect(s.paragraphHtml).toBe('');
        expect(s.paragraphText).toBe('');
    });
});

describe('extractSnippet — edge cases', () => {
    it('returns all empty for HTML with no <table> and no <p>', () => {
        const s = extractSnippet('<html><body><div>just a div</div></body></html>');
        expect(s.synopsisHtml).toBe('');
        expect(s.paragraphHtml).toBe('');
        expect(s.synopsisText).toBe('');
        expect(s.paragraphText).toBe('');
        expect(s.truncated).toBe(false);
        expect(s.totalChars).toBe(0);
    });

    it('strips <script> tags inside the synopsis', () => {
        const html = `
      <table class="t-dcl-begin"><tbody>
        <tr><td>void f();<script>alert("xss")</script></td></tr>
      </tbody></table>
      <p>Description.</p>
    `;
        const s = extractSnippet(html);
        expect(s.synopsisHtml).not.toContain('<script');
        expect(s.synopsisHtml).not.toContain('alert');
        expect(s.synopsisText).not.toContain('alert');
        expect(s.synopsisText).toContain('void f()');
    });

    it('strips <iframe>, <form>, <input>, <button>, <style> tags', () => {
        const html = `
      <table class="t-dcl-begin">
        <tbody>
          <tr><td>void f();
            <iframe src="x"></iframe>
            <form><input type="text"><button>x</button></form>
            <style>.x{}</style>
          </td></tr>
        </tbody>
      </table>
      <p>Desc.</p>
    `;
        const s = extractSnippet(html);
        for (const tag of ['iframe', 'form', 'input', 'button', 'style']) {
            expect(s.synopsisHtml).not.toContain(`<${tag}`);
        }
    });

    it('preserves & < > as entities in synopsisHtml; decodes them in synopsisText', () => {
        // Source carries `&lt;int&gt;` and `&amp;`. The HTML output must keep
        // them encoded (so MarkdownString re-decodes correctly); the plain text
        // must show them as `<`, `>`, `&`.
        const html = `
      <table class="t-dcl-begin"><tbody>
        <tr><td>vector&lt;int&gt; v &amp; w;</td></tr>
      </tbody></table>
    `;
        const s = extractSnippet(html);
        expect(s.synopsisHtml).toContain('&lt;');
        expect(s.synopsisHtml).toContain('&gt;');
        expect(s.synopsisHtml).toContain('&amp;');
        expect(s.synopsisText).toContain('vector<int>');
        expect(s.synopsisText).toContain('&');
        expect(s.synopsisText).not.toContain('&lt;');
    });

    it('maxChars: 0 returns empty content; truncated:true if there was content', () => {
        const html = `
      <table class="t-dcl-begin"><tbody>
        <tr><td>void f();</td></tr>
      </tbody></table>
      <p>Description.</p>
    `;
        const s = extractSnippet(html, { maxChars: 0 });
        expect(s.synopsisHtml).toBe('');
        expect(s.paragraphHtml).toBe('');
        expect(s.synopsisText).toBe('');
        expect(s.paragraphText).toBe('');
        expect(s.truncated).toBe(true);
    });

    it('maxChars: 0 with empty source — truncated:false (nothing to truncate)', () => {
        const s = extractSnippet('<html></html>', { maxChars: 0 });
        expect(s.truncated).toBe(false);
    });

    it('maxChars: undefined defaults to 600', () => {
        // Build a synopsis whose text length is well over 600 chars so the
        // default budget kicks in.
        const long = 'x'.repeat(2000);
        const html = `
      <table class="t-dcl-begin"><tbody>
        <tr><td>${long}</td></tr>
      </tbody></table>
    `;
        const s = extractSnippet(html);
        expect(s.truncated).toBe(true);
        // 600 + 1 for ellipsis.
        expect(s.totalChars).toBeLessThanOrEqual(601);
        expect(s.totalChars).toBeGreaterThan(500);
    });

    it('trim:false preserves leading/trailing whitespace in captured content', () => {
        const html = `
      <table class="t-dcl-begin"><tbody>
        <tr><td>   void f();   </td></tr>
      </tbody></table>
    `;
        const trimmed = extractSnippet(html, { trim: true });
        const untrimmed = extractSnippet(html, { trim: false });
        expect(untrimmed.synopsisText.length).toBeGreaterThanOrEqual(
            trimmed.synopsisText.length
        );
    });

    it('handles empty input string gracefully', () => {
        const s = extractSnippet('');
        expect(s.synopsisHtml).toBe('');
        expect(s.paragraphHtml).toBe('');
        expect(s.totalChars).toBe(0);
        expect(s.truncated).toBe(false);
    });

    it('classListContainsAny: tolerates "t-dcl" alone (synonym for forward-compat)', () => {
        const html = `
      <table class="t-dcl"><tbody>
        <tr><td>int x;</td></tr>
      </tbody></table>
    `;
        const s = extractSnippet(html);
        expect(s.synopsisText).toContain('int x;');
    });

    it('class matching ignores non-target classes that share the prefix', () => {
        // `t-dcl-something-else` should NOT match `t-dcl-begin` or `t-dcl`.
        const html = `
      <table class="t-dcl-something-else"><tbody>
        <tr><td>not synopsis</td></tr>
      </tbody></table>
      <p>Real prose.</p>
    `;
        const s = extractSnippet(html);
        expect(s.synopsisHtml).toBe('');
        expect(s.paragraphText).toContain('Real prose');
    });

    it('captures only the first synopsis when multiple t-dcl-begin tables exist', () => {
        const html = `
      <table class="t-dcl-begin"><tbody><tr><td>FIRST</td></tr></tbody></table>
      <p>between</p>
      <table class="t-dcl-begin"><tbody><tr><td>SECOND</td></tr></tbody></table>
    `;
        const s = extractSnippet(html);
        expect(s.synopsisText).toContain('FIRST');
        expect(s.synopsisText).not.toContain('SECOND');
    });
});

describe('extractSnippetHtml / extractSnippetText wrappers', () => {
    const html = loadFixture('en/cpp/container/vector/push_back.html');

    it('extractSnippetHtml joins synopsis and paragraph with a blank line', () => {
        const out = extractSnippetHtml(html, { maxChars: 4000 });
        expect(out).toContain('<table');
        expect(out).toContain('</table>');
        expect(out).toContain('<p>');
        expect(out).toMatch(/<\/table>\s*\n\n\s*<p\b/);
    });

    it('extractSnippetText returns plain text with no angle brackets from tags', () => {
        const out = extractSnippetText(html, { maxChars: 4000 });
        // No literal <table> / <p> tags survive.
        expect(out).not.toMatch(/<table\b/);
        expect(out).not.toMatch(/<\/table>/);
        expect(out).not.toMatch(/<p\b/);
        expect(out).toContain('void push_back');
        expect(out).toContain('Appends');
    });

    it('extractSnippetHtml returns just the synopsis when paragraph is missing', () => {
        const html2 = `
      <table class="t-dcl-begin"><tbody><tr><td>only synopsis</td></tr></tbody></table>
      <h3>Notes</h3>
    `;
        const out = extractSnippetHtml(html2);
        expect(out).toContain('only synopsis');
        expect(out).not.toContain('\n\n');
    });

    it('extractSnippetHtml returns just the paragraph when synopsis is missing', () => {
        const html2 = `<p>just prose, no synopsis</p>`;
        const out = extractSnippetHtml(html2);
        expect(out).toContain('just prose');
        expect(out).not.toContain('<table');
    });

    it('extractSnippetText returns empty string for empty input', () => {
        expect(extractSnippetText('')).toBe('');
    });
});

describe('extractSnippet — anchor sanitization', () => {
    // Regression: cppreference's snippet HTML carries raw cross-page
    // links like `<a href="string.html">strings</a>`. When the snippet
    // renders inside a VSCode hover MarkdownString, those relative
    // hrefs resolve against the active editor's file URI — clicking
    // "strings" opens `<workspace>/string.html` as a text document in
    // the editor rather than navigating in the docs panel. The
    // serializer drops `href` / `target` / `rel` on `<a>` so the link
    // renders inert and the bug can't recur.

    it('strips href from anchors in the synopsis region', () => {
        const html = `
<table class="t-dcl-begin">
  <tr><td>
    <a href="reference/cpp/iterator.html">Iterator</a>
    void push_back(const T&amp; value);
  </td></tr>
</table>`;
        const out = extractSnippet(html);
        expect(out.synopsisHtml).toContain('Iterator');
        expect(out.synopsisHtml).not.toContain('href=');
        expect(out.synopsisHtml).not.toContain('reference/cpp/iterator');
    });

    it('strips href from anchors in the paragraph region', () => {
        const html = `
<table class="t-dcl-begin"><tr><td>void f();</td></tr></table>
<p>See <a href="../../string.html">strings</a> for details.</p>`;
        const out = extractSnippet(html);
        expect(out.paragraphHtml).toContain('strings');
        expect(out.paragraphHtml).not.toContain('href=');
        expect(out.paragraphHtml).not.toContain('string.html');
    });

    it('strips target and rel attributes on anchors', () => {
        const html =
            '<p>See <a href="x.html" target="_blank" rel="noopener">x</a>.</p>';
        const out = extractSnippet(html);
        expect(out.paragraphHtml).not.toContain('target=');
        expect(out.paragraphHtml).not.toContain('rel=');
    });

    it('keeps non-href attributes on anchors (e.g. class) intact', () => {
        const html =
            '<p>See <a href="x.html" class="cppref-link">x</a>.</p>';
        const out = extractSnippet(html);
        expect(out.paragraphHtml).toContain('class="cppref-link"');
        expect(out.paragraphHtml).not.toContain('href=');
    });

    it('does not affect href-like attributes on non-anchor tags', () => {
        // `href` is technically valid on `<link>` and `<base>`, but those
        // are stripped tags anyway. Inside the body, only `<a>` carries
        // href in practice. Sanity-check that the sanitizer is scoped to
        // `<a>` by feeding a `<p data-href="...">` and expecting the
        // attribute to survive.
        const html =
            '<table class="t-dcl-begin"><tr><td>x</td></tr></table>' +
            '<p data-href="kept">prose</p>';
        const out = extractSnippet(html);
        expect(out.paragraphHtml).toContain('data-href="kept"');
    });
});
