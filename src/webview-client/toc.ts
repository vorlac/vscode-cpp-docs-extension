/**
 * Auto-generated table of contents.
 *
 * Walks the document for `<h2>` / `<h3>` elements after mount, emits an
 * `<aside class="cppref-toc">` floated to the right of the content
 * column (when the viewport is wide enough; CSS hides it on narrow
 * panels), and tracks the active section as the user scrolls via
 * `IntersectionObserver`. Heading anchors get a hover-pilcrow that
 * copies a deep link to the clipboard.
 *
 * The module is idempotent: re-running rebuilds the TOC against the
 * current DOM, which is the right behavior because each `loadPageInWebview`
 * replaces `webview.html` and the bootstrap script re-runs.
 */

const TOC_ID = 'cppref-toc';
const TOC_SELECTOR = 'h2[id], h3[id]';

function ensureHeadingId(h: HTMLElement, taken: Set<string>): string {
    if (h.id && !taken.has(h.id)) {
        taken.add(h.id);
        return h.id;
    }
    // Slug from text content; cppreference normally provides one already so
    // this branch only fires for stray headings that didn't get an id.
    const slug = (h.textContent ?? '')
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 64);
    let candidate = slug || 'section';
    let n = 2;
    while (taken.has(candidate)) {
        candidate = `${slug}-${n++}`;
    }
    h.id = candidate;
    taken.add(candidate);
    return candidate;
}

function attachAnchorPilcrow(h: HTMLElement, id: string): void {
    if (h.querySelector(':scope > .cppref-anchor')) return;
    const a = document.createElement('a');
    a.className = 'cppref-anchor cppref-no-intercept';
    a.href = '#' + id;
    a.textContent = '¶';
    a.setAttribute('aria-label', 'Copy link to section');
    a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const url = location.href.split('#')[0] + '#' + id;
        history.replaceState(null, '', '#' + id);
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (navigator.clipboard) {
            void navigator.clipboard.writeText(url).catch(() => {
                // clipboard unavailable in webview sandbox — silent fail
            });
        }
    });
    h.appendChild(a);
}

function buildToc(): HTMLElement | undefined {
    const headings = Array.from(
        document.querySelectorAll<HTMLElement>(TOC_SELECTOR)
    ).filter((h) => {
        // Skip headings inside the breadcrumb, attribution footer, or the
        // TOC itself. The cppreference body proper is what we want.
        return (
            !h.closest('.cppref-breadcrumb') &&
            !h.closest('.cppref-attribution') &&
            !h.closest('.cppref-toc')
        );
    });

    if (headings.length < 3) return undefined;

    const taken = new Set<string>();
    for (const h of Array.from(document.querySelectorAll<HTMLElement>('[id]'))) {
        if (h.id) taken.add(h.id);
    }

    const aside = document.createElement('aside');
    aside.id = TOC_ID;
    aside.className = 'cppref-toc cppref-no-intercept';
    aside.setAttribute('aria-label', 'On this page');

    const title = document.createElement('div');
    title.className = 'cppref-toc-title';
    title.textContent = 'On this page';
    aside.appendChild(title);

    const ul = document.createElement('ul');
    for (const h of headings) {
        const id = ensureHeadingId(h, taken);
        attachAnchorPilcrow(h, id);
        const li = document.createElement('li');
        li.className =
            h.tagName === 'H3' ? 'cppref-toc-h3' : 'cppref-toc-h2';
        const a = document.createElement('a');
        a.href = '#' + id;
        a.textContent = (h.textContent ?? '').replace(/¶\s*$/, '').trim();
        a.dataset['tocFor'] = id;
        li.appendChild(a);
        ul.appendChild(li);
    }
    aside.appendChild(ul);
    return aside;
}

function installScrollSpy(toc: HTMLElement): void {
    const links = new Map<string, HTMLAnchorElement>();
    for (const a of Array.from(toc.querySelectorAll<HTMLAnchorElement>('a[data-toc-for]'))) {
        const id = a.dataset['tocFor'];
        if (id) links.set(id, a);
    }
    if (links.size === 0) return;

    const headings: HTMLElement[] = [];
    for (const id of links.keys()) {
        const el = document.getElementById(id);
        if (el) headings.push(el);
    }
    if (headings.length === 0) return;

    // Track which headings are currently in view, plus the closest one
    // above the viewport so a heading-less stretch still highlights the
    // section the user is reading. Updated on every IO callback and on
    // scroll, since IO doesn't fire when no boundary is crossed (e.g.,
    // user scrolls within a section taller than the viewport).
    const visible = new Set<string>();

    const setActive = (id: string | undefined): void => {
        for (const a of links.values()) a.classList.remove('is-active');
        if (id) {
            const a = links.get(id);
            if (a) a.classList.add('is-active');
        }
    };

    const pickActive = (): string | undefined => {
        if (visible.size > 0) {
            // Of the visible headings, pick the one closest to the top of
            // the viewport (smallest positive `getBoundingClientRect().top`).
            let best: { id: string; top: number } | undefined;
            for (const id of visible) {
                const el = document.getElementById(id);
                if (!el) continue;
                const top = el.getBoundingClientRect().top;
                if (!best || top < best.top) {
                    best = { id, top };
                }
            }
            return best?.id;
        }
        // Nothing visible — find the heading whose top is just above the
        // viewport (i.e., the section the user is scrolled into).
        let best: { id: string; top: number } | undefined;
        for (const h of headings) {
            const top = h.getBoundingClientRect().top;
            if (top <= 80 && (!best || top > best.top)) {
                best = { id: h.id, top };
            }
        }
        return best?.id;
    };

    const observer = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const id = (entry.target as HTMLElement).id;
                if (!id) continue;
                if (entry.isIntersecting) visible.add(id);
                else visible.delete(id);
            }
            setActive(pickActive());
        },
        {
            // Bias the activation zone to roughly the top third of the
            // viewport: a heading is "active" when it's near the top, not
            // just any-where on screen.
            rootMargin: '-10% 0px -70% 0px',
            threshold: 0
        }
    );

    for (const h of headings) observer.observe(h);

    // Defensive fallback: also recompute on plain scroll so long sections
    // still update the active marker when no IO boundary fires.
    let scrollPending = false;
    window.addEventListener(
        'scroll',
        () => {
            if (scrollPending) return;
            scrollPending = true;
            requestAnimationFrame(() => {
                scrollPending = false;
                setActive(pickActive());
            });
        },
        { passive: true }
    );
}

export function installToc(): void {
    const run = (): void => {
        if (!document.body) return;
        // Idempotent: tear down any prior TOC so reruns don't double-stack.
        document.getElementById(TOC_ID)?.remove();
        const toc = buildToc();
        if (!toc) return;
        document.body.appendChild(toc);
        installScrollSpy(toc);
    };
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
        run();
    }
}
