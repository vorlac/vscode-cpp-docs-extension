import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    renderPage,
    renderPlaceholder,
    type SharedRenderContext
} from '../../src/ui/surface/shared.js';

const FIXTURE_ROOT = path.resolve(
    __dirname,
    '..',
    'fixtures',
    'cppreference-mini'
);
const PUSH_BACK = path.join(
    FIXTURE_ROOT,
    'en/cpp/container/vector/push_back.html'
);

const CSP_SOURCE = 'https://test.vscode-cdn.net';

function makeWebview(): {
    cspSource: string;
    asWebviewUri: (u: { fsPath: string }) => { toString(): string };
} {
    return {
        cspSource: CSP_SOURCE,
        asWebviewUri: (u: { fsPath: string }) => ({
            toString: () =>
                `${CSP_SOURCE}/webview-resource${u.fsPath.replace(/\\/g, '/')}`
        })
    };
}

function makeUri(fsPath: string): { fsPath: string } {
    return { fsPath };
}

function makeCtx(): SharedRenderContext {
    return {
        webview: makeWebview() as unknown as SharedRenderContext['webview'],
        bootstrapUri: makeUri(
            '/ext/dist/client/bootstrap.js'
        ) as unknown as SharedRenderContext['bootstrapUri']
    };
}

describe('shared.renderPage', () => {
    const PAGE_DIR = path.dirname(PUSH_BACK);
    const DOCS_DIR = FIXTURE_ROOT;
    const PAGE_DIR_URI = makeUri(PAGE_DIR);
    const DOCS_DIR_URI = makeUri(DOCS_DIR);

    it('rewrites a real cppreference page through the full pipeline', async () => {
        const html = await renderPage(makeCtx(), {
            filePath: PUSH_BACK,
            pagePath: 'cpp/container/vector/push_back',
            pageDirUri: PAGE_DIR_URI as unknown as never,
            documentsDir: DOCS_DIR_URI as unknown as never,
            attributionEnabled: true,
            cppStandard: 'cxx20'
        });

        expect(html.toLowerCase().startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
        // base href is the page directory, not the docset root —
        // cppreference's relative paths (../../../common/ext.css) resolve only
        // when base = page dir
        expect(html).toContain(
            `<base href="${CSP_SOURCE}/webview-resource${PAGE_DIR.replace(/\\/g, '/')}/">`
        );
        expect(html).toContain(
            `src="${CSP_SOURCE}/webview-resource/ext/dist/client/bootstrap.js"`
        );
        expect(html).toContain(
            'href="https://en.cppreference.com/w/cpp/container/vector/push_back"'
        );
        expect(html).toContain('push_back');
        expect(html).not.toContain('googletagmanager');
    });

    it('embeds docsetWebviewBase as the documents-dir prefix (drives click-intercept)', async () => {
        const html = await renderPage(makeCtx(), {
            filePath: PUSH_BACK,
            pagePath: 'cpp/container/vector/push_back',
            pageDirUri: PAGE_DIR_URI as unknown as never,
            documentsDir: DOCS_DIR_URI as unknown as never,
            attributionEnabled: true
        });
        expect(html).toContain(
            `"docsetWebviewBase":"${CSP_SOURCE}/webview-resource${DOCS_DIR.replace(/\\/g, '/')}/"`
        );
    });

    it('honors attributionEnabled=false by hiding the footer (markup persists)', async () => {
        const html = await renderPage(makeCtx(), {
            filePath: PUSH_BACK,
            pagePath: 'cpp/container/vector/push_back',
            pageDirUri: PAGE_DIR_URI as unknown as never,
            documentsDir: DOCS_DIR_URI as unknown as never,
            attributionEnabled: false
        });
        expect(html).toContain(
            'class="cppref-attribution cppref-attribution--hidden"'
        );
        expect(html).toContain(
            'href="https://en.cppreference.com/w/cpp/container/vector/push_back"'
        );
    });

    it('appends a trailing slash to the base href when the webview URI lacks one', async () => {
        const ctx = {
            ...makeCtx(),
            webview: {
                cspSource: CSP_SOURCE,
                asWebviewUri: () => ({
                    toString: () => `${CSP_SOURCE}/no-slash`
                })
            } as unknown as SharedRenderContext['webview']
        };
        const html = await renderPage(ctx, {
            filePath: PUSH_BACK,
            pagePath: 'cpp/container/vector/push_back',
            pageDirUri: PAGE_DIR_URI as unknown as never,
            documentsDir: DOCS_DIR_URI as unknown as never,
            attributionEnabled: true
        });
        expect(html).toContain(`<base href="${CSP_SOURCE}/no-slash/">`);
    });
});

describe('shared.renderPlaceholder', () => {
    it('emits a shell HTML with no <base> when no docset is configured', () => {
        const html = renderPlaceholder(makeCtx(), {
            attribution: { pagePath: 'cpp', enabled: true }
        });
        expect(html).not.toContain('<base ');
        expect(html).toContain(
            '<meta http-equiv="Content-Security-Policy"'
        );
        expect(html).toContain(
            `src="${CSP_SOURCE}/webview-resource/ext/dist/client/bootstrap.js"`
        );
        expect(html).toContain('<footer class="cppref-attribution">');
    });

    it('respects custom title and bodyHtml', () => {
        const html = renderPlaceholder(makeCtx(), {
            attribution: { pagePath: 'cpp', enabled: true },
            title: 'Custom Title',
            bodyHtml: '<p>custom body</p>'
        });
        expect(html).toContain('<title>Custom Title</title>');
        expect(html).toContain('<p>custom body</p>');
    });

    it('passes cppStandard through to the body data attribute', () => {
        const html = renderPlaceholder(makeCtx(), {
            attribution: { pagePath: 'cpp', enabled: true },
            cppStandard: 'cxx17'
        });
        expect(html).toContain('<body data-cpp-std="cxx17">');
    });

    // Fix C (iter 37) — `noDocsets: true` swaps the welcome body for the
    // install-CTA variant. The default `<em>` instructions are
    // unactionable when zero docsets are installed; the user needs a
    // single click to fix the empty state. Pinning the link text +
    // command keeps the contract explicit.
    it('noDocsets variant exposes a clickable install command link', () => {
        const html = renderPlaceholder(makeCtx(), {
            attribution: { pagePath: 'cpp', enabled: true },
            noDocsets: true
        });
        expect(html).toContain('command:cppDocs.installCppreference');
        expect(html).toContain('Install cppreference now');
        expect(html).toContain('command:cppDocs.showOutput');
    });

    it('noDocsets=false (or omitted) renders the prose welcome body (no command links)', () => {
        const html = renderPlaceholder(makeCtx(), {
            attribution: { pagePath: 'cpp', enabled: true }
        });
        // The default body uses <em>command names</em>, not <a> links —
        // so no command: URI surfaces in the body. (The body still
        // mentions the command names by text.)
        expect(html).not.toContain('command:cppDocs.installCppreference');
        // Prose phrasing of the install command is still present.
        expect(html).toContain('C++ Docs: Install cppreference');
    });

    it('explicit bodyHtml overrides the noDocsets variant', () => {
        const html = renderPlaceholder(makeCtx(), {
            attribution: { pagePath: 'cpp', enabled: true },
            noDocsets: true,
            bodyHtml: '<p>custom override</p>'
        });
        expect(html).toContain('<p>custom override</p>');
        expect(html).not.toContain('command:cppDocs.installCppreference');
    });
});
