import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rewriteHtml } from '../../src/webview-host/rewriter.js';
import type {
    AttributionContext,
    TemplateContext
} from '../../src/webview-host/template.js';

const FIXTURE_NONCE = 'TESTNONCE0123456789ABCDEFGHJKLMN';
const CSP_SOURCE = 'https://test.vscode-cdn.net';
const BASE_HREF = 'https://test.vscode-cdn.net/docset/cppreference/';
const BOOTSTRAP_URI =
    'https://test.vscode-cdn.net/extension/dist/client/bootstrap.js';

const TEMPLATE: TemplateContext = {
    cspSource: CSP_SOURCE,
    nonce: FIXTURE_NONCE,
    baseHref: BASE_HREF,
    bootstrapScriptUri: BOOTSTRAP_URI,
    docsetWebviewBase: BASE_HREF,
    cppStandard: 'cxx20'
};

function ctx(pagePath: string): {
    template: TemplateContext;
    attribution: AttributionContext;
} {
    return {
        template: TEMPLATE,
        attribution: { pagePath, enabled: true }
    };
}

describe('rewriteHtml — synthetic inputs', () => {
    it('preserves doctype', () => {
        const out = rewriteHtml(
            '<!DOCTYPE html><html><head></head><body></body></html>',
            ctx('cpp')
        );
        expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    });

    it('injects the early head block (CSP/base/bootstrap) as the first children of <head>', () => {
        const out = rewriteHtml(
            '<!DOCTYPE html><html><head><title>x</title></head><body></body></html>',
            ctx('cpp')
        );
        const headOpen = out.indexOf('<head>');
        const cspIdx = out.indexOf('<meta http-equiv="Content-Security-Policy"');
        const titleIdx = out.indexOf('<title>x</title>');
        expect(headOpen).toBeGreaterThanOrEqual(0);
        expect(cspIdx).toBeGreaterThan(headOpen);
        expect(titleIdx).toBeGreaterThan(cspIdx);
    });

    it('injects the late head block (theme <style>) as the LAST children of <head>, before </head>', () => {
        const out = rewriteHtml(
            '<!DOCTYPE html><html><head><link rel="stylesheet" href="x.css"><title>x</title></head><body></body></html>',
            ctx('cpp')
        );
        const linkIdx = out.indexOf('<link rel="stylesheet" href="x.css">');
        const themeIdx = out.indexOf('--cppref-bg');
        const headClose = out.indexOf('</head>');
        expect(linkIdx).toBeGreaterThan(0);
        expect(themeIdx).toBeGreaterThan(linkIdx);
        expect(headClose).toBeGreaterThan(themeIdx);
    });

    it('places theme <style> AFTER cppreference-style <link rel="stylesheet"> so source-order wins', () => {
        // CSS source order = later wins for equal specificity. Theme MUST be
        // emitted after cppreference's stylesheet link or VSCode-theme-bound
        // body { background, color } rules get overridden by ext.css.
        const out = rewriteHtml(
            `<!DOCTYPE html><html><head>
        <link rel="stylesheet" href="../../../common/ext.css">
        <link rel="stylesheet" href="../../../common/site_modules.css">
        <title>t</title>
      </head><body></body></html>`,
            ctx('cpp')
        );
        const lastLinkIdx = out.lastIndexOf(
            '<link rel="stylesheet" href="../../../common/site_modules.css">'
        );
        const themeStyleIdx = out.indexOf('--cppref-bg');
        expect(lastLinkIdx).toBeGreaterThan(0);
        expect(themeStyleIdx).toBeGreaterThan(lastLinkIdx);
    });

    it('does NOT emit the theme <style> in the early head block', () => {
        const out = rewriteHtml(
            '<!DOCTYPE html><html><head><title>t</title></head><body></body></html>',
            ctx('cpp')
        );
        const cspIdx = out.indexOf('Content-Security-Policy');
        const titleIdx = out.indexOf('<title>t</title>');
        const themeIdx = out.indexOf('--cppref-bg');
        // theme must come AFTER the title, i.e. AFTER all of head's existing
        // children — never sandwiched between CSP and the page's own tags.
        expect(cspIdx).toBeGreaterThanOrEqual(0);
        expect(titleIdx).toBeGreaterThan(cspIdx);
        expect(themeIdx).toBeGreaterThan(titleIdx);
    });

    it('injects only one head-injections block even if HTML has duplicate <head>', () => {
        const out = rewriteHtml(
            '<html><head></head><head></head><body></body></html>',
            ctx('cpp')
        );
        const matches = out.match(/<meta http-equiv="Content-Security-Policy"/g) ?? [];
        expect(matches).toHaveLength(1);
    });

    it('injects attribution footer immediately before </body>', () => {
        const out = rewriteHtml(
            '<html><head></head><body><p>content</p></body></html>',
            ctx('cpp/container/vector/push_back')
        );
        const footerIdx = out.indexOf('<footer class="cppref-attribution"');
        const bodyClose = out.indexOf('</body>');
        expect(footerIdx).toBeGreaterThan(0);
        expect(bodyClose).toBeGreaterThan(footerIdx);
        // No content between footer end and </body>
        const between = out.slice(out.indexOf('</footer>') + '</footer>'.length, bodyClose);
        expect(between.trim()).toBe('');
    });

    it('escapes raw <, >, & in text content', () => {
        const out = rewriteHtml(
            '<html><head></head><body><pre>a&amp;b &lt; c</pre></body></html>',
            ctx('cpp')
        );
        expect(out).toContain('<pre>a&amp;b &lt; c</pre>');
    });

    it('escapes < that originated as &lt; in source (round-trip)', () => {
        const out = rewriteHtml(
            '<html><head></head><body><code>vector&lt;int&gt;</code></body></html>',
            ctx('cpp')
        );
        expect(out).toContain('<code>vector&lt;int&gt;</code>');
    });

    it('emits no closing tag for void elements (br, img, input, link, meta, col, source, wbr, area, base, embed, hr)', () => {
        const out = rewriteHtml(
            `<html><head>
        <link rel="stylesheet" href="x.css">
        <meta name="x" content="y">
      </head><body>
        <img src="a.png" alt="a">
        text<br>more
        <input type="text">
        <hr>
        <table><col><col></table>
        <video><source src="x.mp4"></video>
        word<wbr>break
      </body></html>`,
            ctx('cpp')
        );
        expect(out).not.toMatch(/<\/(?:br|img|input|link|meta|col|source|wbr|area|base|embed|hr)>/);
    });

    it('strips <script> tags including their content', () => {
        const out = rewriteHtml(
            `<html><head>
        <script>alert("xss")</script>
        <script src="https://googletagmanager.com/gtag/js"></script>
      </head><body>
        <script>mw.config.set({foo: "bar"})</script>
        <p>kept</p>
      </body></html>`,
            ctx('cpp')
        );
        expect(out).not.toContain('alert(');
        expect(out).not.toContain('googletagmanager');
        expect(out).not.toContain('mw.config');
        expect(out).toContain('<p>kept</p>');
        // Our own bootstrap script (with nonce) is still injected
        expect(out).toContain(`<script nonce="${FIXTURE_NONCE}"`);
    });

    it('preserves <link rel="stylesheet"> and <style> blocks (CSS path is allowed under CSP)', () => {
        const out = rewriteHtml(
            `<html><head>
        <link rel="stylesheet" href="../common/ext.css">
        <style>p { color: red; }</style>
      </head><body></body></html>`,
            ctx('cpp')
        );
        expect(out).toContain('<link rel="stylesheet" href="../common/ext.css">');
        expect(out).toContain('<style>p { color: red; }</style>');
    });

    it('strips HTML comments (defensive against malformed --> inside the body)', () => {
        const out = rewriteHtml(
            '<html><head></head><body><!-- a comment --></body></html>',
            ctx('cpp')
        );
        expect(out).not.toContain('<!-- a comment -->');
        expect(out).not.toContain('a comment');
    });

    it('preserves attribute values, escaping " and & where needed', () => {
        const out = rewriteHtml(
            `<html><head></head><body><a href="x?a=1&amp;b=2" title='He said "hi"'>l</a></body></html>`,
            ctx('cpp')
        );
        expect(out).toContain('href="x?a=1&amp;b=2"');
        expect(out).toContain('title="He said &quot;hi&quot;"');
    });

    it('preserves boolean attributes without spurious empty values', () => {
        // htmlparser2 reports boolean attrs with empty string value; our serializer
        // should emit the bare name to round-trip cleanly.
        const out = rewriteHtml(
            '<html><head></head><body><input disabled type="text"></body></html>',
            ctx('cpp')
        );
        expect(out).toMatch(/<input disabled type="text">/);
    });

    it('keeps <script> tags when stripScripts is disabled (escape hatch)', () => {
        const out = rewriteHtml(
            '<html><head><script>foo()</script></head><body></body></html>',
            ctx('cpp'),
            { stripScripts: false }
        );
        expect(out).toContain('<script>');
        expect(out).toContain('foo()');
    });
});

const FIXTURE_ROOT = path.resolve(
    __dirname,
    '..',
    'fixtures',
    'cppreference-mini'
);

const FIXTURES: { name: string; relPath: string; pagePath: string; mustContain: string }[] = [
    {
        name: 'std::vector::push_back',
        relPath: 'en/cpp/container/vector/push_back.html',
        pagePath: 'cpp/container/vector/push_back',
        mustContain: 'push_back'
    },
    {
        name: 'std::sort',
        relPath: 'en/cpp/algorithm/sort.html',
        pagePath: 'cpp/algorithm/sort',
        mustContain: 'sort'
    },
    {
        name: 'std::basic_string::data',
        relPath: 'en/cpp/string/basic_string/data.html',
        pagePath: 'cpp/string/basic_string/data',
        mustContain: 'basic_string'
    },
    {
        name: '<iostream> header',
        relPath: 'en/cpp/header/iostream.html',
        pagePath: 'cpp/header/iostream',
        mustContain: 'iostream'
    },
    {
        name: 'integer types',
        relPath: 'en/cpp/types/integer.html',
        pagePath: 'cpp/types/integer',
        mustContain: 'int'
    }
];

describe('rewriteHtml — theme defense (inline-style + bgcolor stripping)', () => {
    it('strips inline background/color declarations so the theme block can win', () => {
        const out = rewriteHtml(
            '<!DOCTYPE html><html><head></head><body><table><tr style="background-color: white; padding: 4px"><td style="color: black; width: 10em">x</td></tr></table></body></html>',
            ctx('cpp')
        );
        expect(out).not.toMatch(/background-color:\s*white/);
        expect(out).not.toMatch(/color:\s*black/);
        // Layout-relevant properties survive.
        expect(out).toMatch(/padding:\s*4px/);
        expect(out).toMatch(/width:\s*10em/);
    });

    it('drops the bgcolor HTML attribute entirely', () => {
        const out = rewriteHtml(
            '<!DOCTYPE html><html><head></head><body><tr bgcolor="#ddd"><td>x</td></tr></body></html>',
            ctx('cpp')
        );
        expect(out).not.toContain('bgcolor');
    });

    it('removes a style attribute that becomes empty after sanitization', () => {
        const out = rewriteHtml(
            '<!DOCTYPE html><html><head></head><body><div style="background:red; color:white"></div></body></html>',
            ctx('cpp')
        );
        expect(out).not.toContain('<div style=');
    });
});

describe.each(FIXTURES)(
    'rewriteHtml — fixture: $name',
    ({ relPath, pagePath, mustContain }) => {
        const input = readFileSync(path.join(FIXTURE_ROOT, relPath), 'utf8');
        const out = rewriteHtml(input, ctx(pagePath));

        it('preserves the leading <!DOCTYPE html> declaration', () => {
            expect(out.toLowerCase().startsWith('<!doctype html>')).toBe(true);
        });

        it('emits exactly one CSP meta as the first child of <head>', () => {
            const headOpenEnd = out.indexOf('<head>') + '<head>'.length;
            const headClose = out.indexOf('</head>');
            expect(headOpenEnd).toBeGreaterThan(0);
            expect(headClose).toBeGreaterThan(headOpenEnd);
            const head = out.slice(headOpenEnd, headClose);
            const cspMatches = head.match(
                /<meta http-equiv="Content-Security-Policy"/g
            );
            expect(cspMatches).toHaveLength(1);
            // CSP is at the start of the head (after our leading newline)
            expect(head.trimStart().startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
        });

        it('injects the configured <base href>', () => {
            expect(out).toContain(`<base href="${BASE_HREF}">`);
        });

        it('injects nonce-bound theme <style> and bootstrap <script>', () => {
            expect(out).toContain(`<style nonce="${FIXTURE_NONCE}">`);
            expect(out).toContain(
                `<script nonce="${FIXTURE_NONCE}">window.__cppref =`
            );
            expect(out).toContain(
                `<script nonce="${FIXTURE_NONCE}" src="${BOOTSTRAP_URI}">`
            );
        });

        it('strips every <script> from the source page', () => {
            // Only nonce-bound scripts (ours) survive. Source cppreference scripts
            // include googletagmanager and mw.* — verify zero of those slip through.
            expect(out).not.toContain('googletagmanager');
            expect(out).not.toContain('google-analytics');
            expect(out).not.toMatch(/mw\.config\.set/);
            expect(out).not.toMatch(/mw\.loader\.(?:implement|load)/);
            // Every <script> tag in the output must carry our nonce.
            const scriptOpens = out.match(/<script\b[^>]*>/g) ?? [];
            for (const s of scriptOpens) {
                expect(s).toContain(`nonce="${FIXTURE_NONCE}"`);
            }
        });

        it('emits no closing tags for void elements', () => {
            expect(out).not.toMatch(
                /<\/(?:br|img|input|link|meta|col|source|wbr|area|base|embed|hr)>/
            );
        });

        it('injects the attribution footer immediately before </body>', () => {
            const footerIdx = out.indexOf(
                `<footer class="cppref-attribution">`
            );
            const bodyCloseIdx = out.indexOf('</body>');
            expect(footerIdx).toBeGreaterThan(0);
            expect(bodyCloseIdx).toBeGreaterThan(footerIdx);
            expect(out).toContain(
                `href="https://en.cppreference.com/w/${pagePath}"`
            );
        });

        it('preserves the page-specific identifying content', () => {
            expect(out.toLowerCase()).toContain(mustContain.toLowerCase());
        });

        it('preserves the upstream <link rel="stylesheet"> chain', () => {
            // cppreference always loads ext.css; that path must survive.
            expect(out).toMatch(
                /<link[^>]*rel="stylesheet"[^>]*href="[^"]*ext\.css"/
            );
        });

        it('emits the theme <style> AFTER cppreference\'s <link rel="stylesheet"> chain (source-order win)', () => {
            // Bug A regression guard: when the theme block landed at the start
            // of <head>, ext.css overrode body { background, color } and the
            // page rendered with cppreference's stock light palette regardless
            // of the active VSCode theme. The theme <style> must come after
            // EVERY <link rel="stylesheet"> in the head so it wins source order.
            const headOpenEnd = out.indexOf('<head>') + '<head>'.length;
            const headClose = out.indexOf('</head>');
            const head = out.slice(headOpenEnd, headClose);
            const linkRe = /<link\b[^>]*rel="stylesheet"[^>]*>/g;
            const links = [...head.matchAll(linkRe)];
            expect(links.length).toBeGreaterThan(0);
            const lastLink = links[links.length - 1]!;
            const lastLinkEnd = lastLink.index! + lastLink[0].length;
            const themeIdx = head.indexOf('--cppref-bg');
            expect(themeIdx).toBeGreaterThan(lastLinkEnd);
        });
    }
);
