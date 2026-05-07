import { describe, expect, it } from 'vitest';
import {
    classifyClick,
    type ClickInput
} from '../../src/webview-client/nav.js';

const DOCSET_BASE = 'https://test.vscode-cdn.net/docset/cppreference/';

function defaults(over: Partial<ClickInput> = {}): ClickInput {
    return {
        rawHref: '',
        resolvedHref: '',
        hasExternalMarker: false,
        inNoIntercept: false,
        inInteractiveAncestor: false,
        button: 0,
        modifierKeyPressed: false,
        docsetWebviewBase: DOCSET_BASE,
        ...over
    };
}

describe('classifyClick', () => {
    it('skips middle/right clicks', () => {
        expect(classifyClick(defaults({ button: 1 }))).toEqual({ kind: 'skip' });
        expect(classifyClick(defaults({ button: 2 }))).toEqual({ kind: 'skip' });
    });

    it('skips clicks inside our own UI (.cppref-no-intercept)', () => {
        expect(
            classifyClick(
                defaults({
                    inNoIntercept: true,
                    rawHref: 'foo.html',
                    resolvedHref: `${DOCSET_BASE}foo.html`
                })
            )
        ).toEqual({ kind: 'skip' });
    });

    it('skips clicks inside summary/details/button/input (native semantics)', () => {
        expect(
            classifyClick(
                defaults({
                    inInteractiveAncestor: true,
                    rawHref: 'foo.html',
                    resolvedHref: `${DOCSET_BASE}foo.html`
                })
            )
        ).toEqual({ kind: 'skip' });
    });

    it('treats hash-only hrefs as in-page anchors', () => {
        expect(
            classifyClick(
                defaults({ rawHref: '#section-3', resolvedHref: 'irrelevant' })
            )
        ).toEqual({ kind: 'anchor', id: 'section-3' });
    });

    it('decodes percent-encoded hash hrefs (docs/06-gotchas.md #3)', () => {
        expect(
            classifyClick(
                defaults({
                    rawHref: '%23std-vector-push_back-1',
                    resolvedHref: ''
                })
            )
        ).toEqual({ kind: 'anchor', id: 'std-vector-push_back-1' });
    });

    it('routes data-cppref-external anchors to openExternal', () => {
        expect(
            classifyClick(
                defaults({
                    hasExternalMarker: true,
                    rawHref: 'https://en.cppreference.com/w/cpp',
                    resolvedHref: 'https://en.cppreference.com/w/cpp'
                })
            )
        ).toEqual({
            kind: 'external',
            href: 'https://en.cppreference.com/w/cpp'
        });
    });

    it('routes modifier-key clicks to openExternal even on in-docset URLs (cmd-click)', () => {
        expect(
            classifyClick(
                defaults({
                    modifierKeyPressed: true,
                    rawHref: 'foo.html',
                    resolvedHref: `${DOCSET_BASE}foo.html`
                })
            )
        ).toEqual({
            kind: 'external',
            href: `${DOCSET_BASE}foo.html`
        });
    });

    it('routes in-docset URLs to nav', () => {
        expect(
            classifyClick(
                defaults({
                    rawHref: '../algorithm/sort.html',
                    resolvedHref: `${DOCSET_BASE}en/cpp/algorithm/sort.html`
                })
            )
        ).toEqual({
            kind: 'nav',
            href: `${DOCSET_BASE}en/cpp/algorithm/sort.html`
        });
    });

    it('routes off-docset URLs to openExternal', () => {
        expect(
            classifyClick(
                defaults({
                    rawHref: 'https://example.com/x',
                    resolvedHref: 'https://example.com/x'
                })
            )
        ).toEqual({
            kind: 'external',
            href: 'https://example.com/x'
        });
    });

    it('treats empty docsetWebviewBase as "no in-docset routing" — defaults to external', () => {
        expect(
            classifyClick(
                defaults({
                    docsetWebviewBase: '',
                    rawHref: 'foo.html',
                    resolvedHref: `${DOCSET_BASE}foo.html`
                })
            )
        ).toEqual({
            kind: 'external',
            href: `${DOCSET_BASE}foo.html`
        });
    });

    it('survives malformed percent-encoding in href without throwing', () => {
        // %ZZ is not a valid percent escape — decodeURIComponent throws.
        // The classifier must fall back to the raw value.
        expect(() =>
            classifyClick(
                defaults({ rawHref: '%ZZ', resolvedHref: `${DOCSET_BASE}%ZZ` })
            )
        ).not.toThrow();
        const decision = classifyClick(
            defaults({ rawHref: '%ZZ', resolvedHref: `${DOCSET_BASE}%ZZ` })
        );
        expect(decision.kind).toBe('nav');
    });

    it('precedence: skip > anchor > external-marker > modifier > in-docset > external', () => {
        // skip wins over everything
        expect(
            classifyClick(
                defaults({
                    inNoIntercept: true,
                    rawHref: '#a',
                    hasExternalMarker: true,
                    modifierKeyPressed: true,
                    resolvedHref: `${DOCSET_BASE}foo`
                })
            ).kind
        ).toBe('skip');
        // anchor wins over external-marker (hash short-circuits before marker check)
        expect(
            classifyClick(
                defaults({
                    rawHref: '#a',
                    hasExternalMarker: true,
                    resolvedHref: `${DOCSET_BASE}foo`
                })
            ).kind
        ).toBe('anchor');
        // external-marker wins over in-docset
        expect(
            classifyClick(
                defaults({
                    hasExternalMarker: true,
                    rawHref: 'foo',
                    resolvedHref: `${DOCSET_BASE}foo`
                })
            ).kind
        ).toBe('external');
        // modifier wins over in-docset
        expect(
            classifyClick(
                defaults({
                    modifierKeyPressed: true,
                    rawHref: 'foo',
                    resolvedHref: `${DOCSET_BASE}foo`
                })
            ).kind
        ).toBe('external');
    });
});
