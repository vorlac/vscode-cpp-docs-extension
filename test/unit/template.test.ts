import { describe, expect, it } from 'vitest';
import {
    buildAttributionFooter,
    buildCspContent,
    buildHeadEarlyInjections,
    buildHeadLateInjections,
    buildThemeStyleBlock,
    generateNonce,
    renderShellHtml
} from '../../src/webview-host/template.js';

const FIXTURE_NONCE = 'TESTNONCE0123456789ABCDEFGHJKLMN';
const FIXTURE_CSP_SOURCE = 'https://test.vscode-cdn.net';
const FIXTURE_BASE = 'https://test.vscode-cdn.net/docset/cppreference/';
const FIXTURE_BOOTSTRAP =
    'https://test.vscode-cdn.net/extension/dist/client/bootstrap.js';

describe('generateNonce', () => {
    it('produces 32 base62 characters', () => {
        for (let i = 0; i < 16; i++) {
            const n = generateNonce();
            expect(n).toMatch(/^[0-9A-Za-z]{32}$/);
        }
    });

    it('produces distinct values across calls', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 64; i++) {
            seen.add(generateNonce());
        }
        expect(seen.size).toBe(64);
    });
});

describe('buildCspContent', () => {
    const csp = buildCspContent({
        cspSource: FIXTURE_CSP_SOURCE,
        nonce: FIXTURE_NONCE
    });

    it("starts with default-src 'none'", () => {
        expect(csp.startsWith(`default-src 'none'`)).toBe(true);
    });

    it('includes img-src with cspSource, https:, and data:', () => {
        expect(csp).toContain(`img-src ${FIXTURE_CSP_SOURCE} https: data:`);
    });

    it('includes font-src restricted to cspSource', () => {
        expect(csp).toContain(`font-src ${FIXTURE_CSP_SOURCE}`);
    });

    it("includes style-src cspSource plus 'unsafe-inline' (cppreference inline styles)", () => {
        expect(csp).toContain(`style-src ${FIXTURE_CSP_SOURCE} 'unsafe-inline'`);
    });

    it('binds script-src to the nonce only — no unsafe-inline, no host source', () => {
        expect(csp).toContain(`script-src 'nonce-${FIXTURE_NONCE}'`);
        expect(csp).not.toContain(`script-src 'unsafe-inline'`);
        expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    });

    it('omits connect-src, frame-src, and media-src (no need)', () => {
        expect(csp).not.toContain('connect-src');
        expect(csp).not.toContain('frame-src');
        expect(csp).not.toContain('media-src');
    });
});

describe('buildThemeStyleBlock', () => {
    const style = buildThemeStyleBlock(FIXTURE_NONCE);

    it('embeds the nonce on the <style> tag', () => {
        expect(style).toMatch(/^<style nonce="TESTNONCE[^"]+">/);
        expect(style.endsWith('</style>')).toBe(true);
    });

    it('maps cppref CSS variables onto VSCode theme variables', () => {
        expect(style).toContain('--cppref-bg: var(--vscode-sideBar-background, var(--vscode-panel-background, var(--vscode-editor-background)))');
        expect(style).toContain('--cppref-fg: var(--vscode-editor-foreground)');
        expect(style).toContain('--cppref-link: var(--vscode-textLink-foreground)');
        expect(style).toContain('--cppref-code-bg:');
        expect(style).toContain('var(--vscode-textBlockQuote-background');
        expect(style).toContain('--cppref-border:');
    });

    it('applies background and color from cppref vars on html, body', () => {
        expect(style).toMatch(/html,\s*body\s*\{[^}]*background-color:\s*var\(--cppref-bg\)/);
        expect(style).toMatch(/html,\s*body\s*\{[^}]*color:\s*var\(--cppref-fg\)/);
    });

    it('uses VSCode editor font family for code/pre', () => {
        expect(style).toContain('font-family: var(--vscode-editor-font-family)');
    });

    it('forces code/pre foreground to --cppref-code-fg (overrides VSCode webview default that dims inline <code> in HC Light)', () => {
        expect(style).toMatch(
            /body code[\s\S]*?color:\s*var\(--cppref-code-fg\)/
        );
    });

    it('hides attribution via dedicated --hidden modifier (markup persists)', () => {
        expect(style).toContain('.cppref-attribution--hidden { display: none !important; }');
    });

    it('boosts link visibility under high-contrast themes', () => {
        expect(style).toMatch(
            /body\.vscode-high-contrast a[\s\S]*?text-decoration:\s*underline/
        );
        expect(style).toMatch(
            /body\.vscode-high-contrast-light a[\s\S]*?text-decoration:\s*underline/
        );
    });
});

describe('buildHeadEarlyInjections', () => {
    it('emits CSP first, then base, then bootstrap data, then bootstrap script', () => {
        const html = buildHeadEarlyInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            baseHref: FIXTURE_BASE,
            bootstrapScriptUri: FIXTURE_BOOTSTRAP,
            docsetWebviewBase: FIXTURE_BASE,
            cppStandard: 'cxx20'
        });

        const cspIdx = html.indexOf('<meta http-equiv="Content-Security-Policy"');
        const baseIdx = html.indexOf('<base href=');
        const dataIdx = html.indexOf('window.__cppref =');
        const scriptIdx = html.indexOf(
            '<script nonce=' + JSON.stringify(FIXTURE_NONCE) + ' src='
        );

        expect(cspIdx).toBeGreaterThanOrEqual(0);
        expect(baseIdx).toBeGreaterThan(cspIdx);
        expect(dataIdx).toBeGreaterThan(baseIdx);
        expect(scriptIdx).toBeGreaterThan(dataIdx);
    });

    it('does NOT emit the theme <style> block (deferred to late injections)', () => {
        const html = buildHeadEarlyInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE,
            standardFilterCss: '/* filter */'
        });
        expect(html).not.toContain('<style nonce=');
        expect(html).not.toContain('--cppref-bg');
        expect(html).not.toContain('/* filter */');
    });

    it('omits <base> when baseHref is undefined', () => {
        const html = buildHeadEarlyInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE
        });
        expect(html).not.toContain('<base ');
    });

    it('omits external bootstrap <script> when bootstrapScriptUri is undefined', () => {
        const html = buildHeadEarlyInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE
        });
        expect(html).not.toMatch(/<script nonce="[^"]+" src=/);
        // inline data block still present
        expect(html).toContain('window.__cppref =');
    });

    it('serializes window.__cppref with docsetWebviewBase, cppStandard, zoomLevel, and scrollTarget', () => {
        const html = buildHeadEarlyInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE,
            cppStandard: 'cxx17'
        });
        // Assertions are per-field rather than a single literal JSON match
        // so adding new bootstrap fields (e.g. codeTheme, codeThemes) won't
        // require rewriting the test every time.
        expect(html).toContain('window.__cppref = {');
        expect(html).toContain(`"docsetWebviewBase":"${FIXTURE_BASE}"`);
        expect(html).toContain('"cppStandard":"cxx17"');
        expect(html).toContain('"zoomLevel":1');
        expect(html).toContain('"scrollTarget":{}');
    });

    it('serializes scrollTarget.anchor into the bootstrap payload when provided', () => {
        const html = buildHeadEarlyInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE,
            cppStandard: 'cxx20',
            scrollTarget: { anchor: 'Member_functions' }
        });
        expect(html).toContain('"scrollTarget":{"anchor":"Member_functions"}');
    });

    it('defaults cppStandard to cxx26 (most permissive) when unspecified', () => {
        const html = buildHeadEarlyInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE
        });
        expect(html).toContain('"cppStandard":"cxx26"');
    });

    it('uses the same nonce in CSP, bootstrap data, and bootstrap script', () => {
        const html = buildHeadEarlyInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            baseHref: FIXTURE_BASE,
            bootstrapScriptUri: FIXTURE_BOOTSTRAP,
            docsetWebviewBase: FIXTURE_BASE
        });
        const cspMatches = html.match(/'nonce-([^']+)'/g) ?? [];
        const scriptMatches = html.match(/<script nonce="([^"]+)"/g) ?? [];

        expect(cspMatches).toHaveLength(1);
        expect(cspMatches[0]).toBe(`'nonce-${FIXTURE_NONCE}'`);
        expect(scriptMatches).toHaveLength(2);
        for (const s of scriptMatches) {
            expect(s).toBe(`<script nonce="${FIXTURE_NONCE}"`);
        }
    });
});

describe('buildHeadLateInjections', () => {
    it('emits the theme <style> block bound to the configured nonce', () => {
        const html = buildHeadLateInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE
        });
        expect(html).toContain(`<style nonce="${FIXTURE_NONCE}">`);
        expect(html).toContain('--cppref-bg: var(--vscode-sideBar-background, var(--vscode-panel-background, var(--vscode-editor-background)))');
    });

    it('does NOT emit CSP, base, bootstrap data, or bootstrap script', () => {
        const html = buildHeadLateInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            baseHref: FIXTURE_BASE,
            bootstrapScriptUri: FIXTURE_BOOTSTRAP,
            docsetWebviewBase: FIXTURE_BASE
        });
        expect(html).not.toContain('Content-Security-Policy');
        expect(html).not.toContain('<base ');
        expect(html).not.toContain('window.__cppref');
        expect(html).not.toMatch(/<script\b/);
    });

    it('appends the standard-filter <style> after the theme <style> when present', () => {
        const html = buildHeadLateInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE,
            standardFilterCss: '/* filter */'
        });
        const themeIdx = html.indexOf('--cppref-bg');
        const filterIdx = html.indexOf('/* filter */');
        expect(themeIdx).toBeGreaterThanOrEqual(0);
        expect(filterIdx).toBeGreaterThan(themeIdx);
        const styleOpens = html.match(/<style nonce="[^"]+">/g) ?? [];
        expect(styleOpens.length).toBe(2);
    });

    it('omits the standard-filter block when standardFilterCss is empty/undefined', () => {
        const noFilter = buildHeadLateInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE
        });
        const styleOpens = noFilter.match(/<style nonce="[^"]+">/g) ?? [];
        expect(styleOpens.length).toBe(1);

        const empty = buildHeadLateInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE,
            standardFilterCss: ''
        });
        const emptyOpens = empty.match(/<style nonce="[^"]+">/g) ?? [];
        expect(emptyOpens.length).toBe(1);
    });
});

describe('buildAttributionFooter', () => {
    it('links to the upstream cppreference page and the CC BY-SA license', () => {
        const html = buildAttributionFooter({
            pagePath: 'cpp/container/vector/push_back',
            enabled: true
        });
        expect(html).toContain(
            'href="https://en.cppreference.com/w/cpp/container/vector/push_back"'
        );
        expect(html).toContain(
            'href="https://creativecommons.org/licenses/by-sa/3.0/"'
        );
    });

    it('marks all anchors with data-cppref-external for click-intercept skip (CC BY-SA, GFDL, source)', () => {
        const html = buildAttributionFooter({
            pagePath: 'cpp',
            enabled: true
        });
        const matches = html.match(/data-cppref-external/g) ?? [];
        expect(matches).toHaveLength(3);
    });

    it('cites both CC BY-SA and GFDL for dual-license compliance (H-3)', () => {
        const html = buildAttributionFooter({
            pagePath: 'cpp',
            enabled: true
        });
        expect(html).toMatch(/CC BY-SA 3\.0/);
        expect(html).toMatch(/GFDL/);
        expect(html).toContain('https://www.gnu.org/licenses/fdl-1.3.html');
    });

    it('keeps markup but adds --hidden modifier when disabled (legal compliance)', () => {
        const enabled = buildAttributionFooter({
            pagePath: 'cpp',
            enabled: true
        });
        const disabled = buildAttributionFooter({
            pagePath: 'cpp',
            enabled: false
        });
        expect(enabled).toContain('class="cppref-attribution"');
        expect(enabled).not.toContain('cppref-attribution--hidden');
        expect(disabled).toContain(
            'class="cppref-attribution cppref-attribution--hidden"'
        );
        // upstream link still present in disabled form
        expect(disabled).toContain(
            'href="https://en.cppreference.com/w/cpp"'
        );
    });
});

describe('buildHeadLateInjections — standard filter style', () => {
    it('injects a separate <style> block when standardFilterCss is provided', () => {
        const html = buildHeadLateInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE,
            standardFilterCss:
                'body[data-cpp-std="cxx17"] .t-since-cxx20 { display: none; }'
        });
        const styleOpens = html.match(/<style nonce="[^"]+">/g) ?? [];
        expect(styleOpens.length).toBe(2); // theme + standard-filter
        expect(html).toContain(
            'body[data-cpp-std="cxx17"] .t-since-cxx20 { display: none; }'
        );
    });

    it('places the standard-filter block AFTER the theme style (so it can override)', () => {
        const html = buildHeadLateInjections({
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            docsetWebviewBase: FIXTURE_BASE,
            standardFilterCss: '/* filter */'
        });
        const themeIdx = html.indexOf('--cppref-bg');
        const filterIdx = html.indexOf('/* filter */');
        expect(themeIdx).toBeGreaterThan(0);
        expect(filterIdx).toBeGreaterThan(themeIdx);
    });
});

describe('renderShellHtml', () => {
    const html = renderShellHtml({
        template: {
            cspSource: FIXTURE_CSP_SOURCE,
            nonce: FIXTURE_NONCE,
            baseHref: FIXTURE_BASE,
            bootstrapScriptUri: FIXTURE_BOOTSTRAP,
            docsetWebviewBase: FIXTURE_BASE,
            cppStandard: 'cxx20'
        },
        attribution: {
            pagePath: 'cpp/container/vector/push_back',
            enabled: true
        },
        title: 'std::vector::push_back',
        bodyHtml: '<h1>std::vector::push_back</h1>'
    });

    it('starts with <!DOCTYPE html> and has lang attribute', () => {
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain('<html lang="en">');
    });

    it('emits head injections (CSP, base, style, bootstrap) inside <head>', () => {
        const headStart = html.indexOf('<head>');
        const headEnd = html.indexOf('</head>');
        expect(headStart).toBeGreaterThanOrEqual(0);
        expect(headEnd).toBeGreaterThan(headStart);
        const head = html.slice(headStart, headEnd);
        expect(head).toContain('<meta http-equiv="Content-Security-Policy"');
        expect(head).toContain(`<base href="${FIXTURE_BASE}">`);
        expect(head).toContain('<style nonce="');
        expect(head).toContain('window.__cppref =');
        expect(head).toContain(`src="${FIXTURE_BOOTSTRAP}"`);
        expect(head).toContain('<title>std::vector::push_back</title>');
    });

    it('sets data-cpp-std on <body> when cppStandard provided', () => {
        expect(html).toContain('<body data-cpp-std="cxx20">');
    });

    it('omits data-cpp-std when cppStandard is undefined', () => {
        const noStd = renderShellHtml({
            template: {
                cspSource: FIXTURE_CSP_SOURCE,
                nonce: FIXTURE_NONCE,
                docsetWebviewBase: FIXTURE_BASE
            },
            attribution: { pagePath: 'cpp', enabled: true },
            title: 't',
            bodyHtml: ''
        });
        expect(noStd).toContain('<body>');
        expect(noStd).not.toContain('data-cpp-std');
    });

    it('places attribution footer after body content, before </body>', () => {
        const bodyStart = html.indexOf('<body');
        const bodyEnd = html.indexOf('</body>');
        const body = html.slice(bodyStart, bodyEnd);
        const headingIdx = body.indexOf('<h1>std::vector::push_back</h1>');
        const footerIdx = body.indexOf('<footer class="cppref-attribution"');
        expect(headingIdx).toBeGreaterThan(0);
        expect(footerIdx).toBeGreaterThan(headingIdx);
    });
});
