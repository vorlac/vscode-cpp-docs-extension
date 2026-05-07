import { describe, expect, it } from 'vitest';
import {
    hrefToTarget,
    NavigationHistory,
    type DocsetWebviewBase,
    type NavTarget
} from '../../src/ui/surface/navigation.js';

const target = (
    pagePath: string,
    docsetId = 1,
    extras: Partial<NavTarget> = {}
): NavTarget => ({ docsetId, pagePath, ...extras });

describe('NavigationHistory', () => {
    it('starts empty — current() undefined, neither direction navigable', () => {
        const h = new NavigationHistory();
        expect(h.current()).toBeUndefined();
        expect(h.canGoBack()).toBe(false);
        expect(h.canGoForward()).toBe(false);
        expect(h.goBack()).toBeUndefined();
        expect(h.goForward()).toBeUndefined();
    });

    it('push sets current and clears the forward stack', () => {
        const h = new NavigationHistory();
        h.push(target('a.html'));
        expect(h.current()?.pagePath).toBe('a.html');
        expect(h.canGoBack()).toBe(false);
        expect(h.canGoForward()).toBe(false);

        h.push(target('b.html'));
        h.push(target('c.html'));
        expect(h.current()?.pagePath).toBe('c.html');
        expect(h.canGoBack()).toBe(true);
        expect(h.canGoForward()).toBe(false);
    });

    it('back/forward walks the stack browser-style', () => {
        const h = new NavigationHistory();
        h.push(target('a'));
        h.push(target('b'));
        h.push(target('c'));

        expect(h.goBack()?.pagePath).toBe('b');
        expect(h.current()?.pagePath).toBe('b');
        expect(h.canGoForward()).toBe(true);

        expect(h.goBack()?.pagePath).toBe('a');
        expect(h.canGoBack()).toBe(false);

        expect(h.goForward()?.pagePath).toBe('b');
        expect(h.goForward()?.pagePath).toBe('c');
        expect(h.canGoForward()).toBe(false);
    });

    it('push after going back clears the forward stack (browser semantics)', () => {
        const h = new NavigationHistory();
        h.push(target('a'));
        h.push(target('b'));
        h.push(target('c'));
        h.goBack(); // active = b
        h.goBack(); // active = a, forward = [b, c]
        h.push(target('d'));
        expect(h.current()?.pagePath).toBe('d');
        expect(h.canGoForward()).toBe(false);
        expect(h.goBack()?.pagePath).toBe('a');
    });

    it('caps the back stack at the configured size', () => {
        const h = new NavigationHistory(3);
        for (let i = 0; i < 10; i++) h.push(target(`p${i}`));
        // current = p9, back at most 3 deep
        let count = 0;
        while (h.goBack()) count++;
        expect(count).toBe(3);
    });

    it('snapshot/restore round-trip preserves active + stacks', () => {
        const h = new NavigationHistory();
        h.push(target('a'));
        h.push(target('b'));
        h.push(target('c'));
        h.goBack(); // active=b, forward=[c]
        const snap = h.snapshot();

        const h2 = new NavigationHistory();
        h2.restore(snap);
        expect(h2.current()?.pagePath).toBe('b');
        expect(h2.canGoBack()).toBe(true);
        expect(h2.canGoForward()).toBe(true);
        expect(h2.goBack()?.pagePath).toBe('a');
        expect(h2.goForward()?.pagePath).toBe('b');
        expect(h2.goForward()?.pagePath).toBe('c');
    });

    it('restore with empty snapshot resets to a clean slate', () => {
        const h = new NavigationHistory();
        h.push(target('x'));
        h.restore({});
        expect(h.current()).toBeUndefined();
        expect(h.canGoBack()).toBe(false);
        expect(h.canGoForward()).toBe(false);
    });
});

describe('hrefToTarget', () => {
    const bases: DocsetWebviewBase[] = [
        {
            docsetId: 1,
            webviewBase: 'https://cdn/cppreference/'
        },
        {
            docsetId: 2,
            webviewBase: 'https://cdn/dash-stl/'
        }
    ];

    it('returns undefined for an off-docset URL', () => {
        expect(hrefToTarget('https://example.com/x', bases)).toBeUndefined();
    });

    it('returns the matching docset and pagePath for an in-docset URL', () => {
        expect(
            hrefToTarget(
                'https://cdn/cppreference/en/cpp/algorithm/sort.html',
                bases
            )
        ).toEqual({ docsetId: 1, pagePath: 'en/cpp/algorithm/sort.html' });
    });

    it('extracts an anchor when the href has a fragment', () => {
        expect(
            hrefToTarget(
                'https://cdn/cppreference/en/cpp/container/vector.html#std-vector-push_back-1',
                bases
            )
        ).toEqual({
            docsetId: 1,
            pagePath: 'en/cpp/container/vector.html',
            anchor: 'std-vector-push_back-1'
        });
    });

    it('strips a trailing query string', () => {
        expect(
            hrefToTarget(
                'https://cdn/cppreference/en/cpp/algorithm/sort.html?foo=bar',
                bases
            )
        ).toEqual({ docsetId: 1, pagePath: 'en/cpp/algorithm/sort.html' });
    });

    it('returns undefined when the href is exactly the docset base (empty pagePath)', () => {
        expect(
            hrefToTarget('https://cdn/cppreference/', bases)
        ).toBeUndefined();
    });

    it('matches the first base in the list, not the longest', () => {
        const overlap: DocsetWebviewBase[] = [
            { docsetId: 99, webviewBase: 'https://cdn/' },
            { docsetId: 1, webviewBase: 'https://cdn/cppreference/' }
        ];
        expect(
            hrefToTarget('https://cdn/cppreference/en/cpp/x.html', overlap)
        ).toEqual({ docsetId: 99, pagePath: 'cppreference/en/cpp/x.html' });
    });
});
