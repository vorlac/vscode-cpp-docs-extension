import type { HostToClientMessage } from '../webview-host/messages.js';
import {
    handleSetCodeTheme,
    installCodeThemePicker
} from './code-theme.js';
import { installNavListener } from './nav.js';
import {
    installBreadcrumbAutoHide,
    installScrollPersistence,
    postHostMessage,
    setActivePage
} from './state.js';
import { applySyntaxHighlight } from './syntax.js';
import { installToc } from './toc.js';

function applyInitialStandard(): void {
    const std = window.__cppref?.cppStandard;
    if (!std) return;
    const apply = (): void => {
        if (document.body) document.body.dataset['cppStd'] = std;
    };
    if (document.body) apply();
    else window.addEventListener('DOMContentLoaded', apply, { once: true });
}

let currentZoom = 1.0;
// Correction factor that scales the entire page so the base text size in the
// main content area matches the editor font size. Computed once at
// DOMContentLoaded (after all CSS — including the late-injected theme block —
// is applied). Transparent to the user: the zoom label always shows the
// user-level zoom where 100% == matches editor font size.
let baseSizeCorrection = 1.0;

function applyZoom(level: number): void {
    currentZoom = level;
    (document.documentElement as HTMLElement).style.zoom = String(baseSizeCorrection * level);
    const label = document.getElementById('cppref-zoom-label');
    if (label) label.textContent = Math.round(level * 100) + '%';
}

function computeAndApplyBaseSizeCorrection(): void {
    const rootStyle = getComputedStyle(document.documentElement);
    const desired = parseFloat(rootStyle.getPropertyValue('--vscode-editor-font-size'));
    if (!desired || desired <= 0) return;

    // Measure the content container rather than the root element to catch any
    // per-container font-size rules cppreference sets on its inner wrappers
    // (e.g. .mw-parser-output or #bodyContent) that survive our theme override.
    const contentEl =
        document.querySelector<Element>('.mw-parser-output, #bodyContent, #mw-content-text') ??
        document.body;
    const actual = parseFloat(getComputedStyle(contentEl).fontSize);
    if (!actual || actual <= 0 || Math.abs(desired - actual) < 0.5) return;

    baseSizeCorrection = desired / actual;
    applyZoom(currentZoom);
}

function installZoomControls(): void {
    const initialZoom = window.__cppref?.zoomLevel ?? 1.0;
    applyZoom(initialZoom);

    const inject = (): void => {
        if (!document.body) return;
        const ctrl = document.createElement('div');
        ctrl.className = 'cppref-zoom-controls cppref-no-intercept';
        ctrl.innerHTML =
            '<button class="cppref-zoom-btn" id="cppref-zoom-out" title="Zoom out">−</button>' +
            '<span class="cppref-zoom-label" id="cppref-zoom-label">' +
            Math.round(initialZoom * 100) + '%</span>' +
            '<button class="cppref-zoom-btn" id="cppref-zoom-in" title="Zoom in">+</button>';
        document.body.appendChild(ctrl);

        document.getElementById('cppref-zoom-out')?.addEventListener('click', () => {
            postHostMessage({ type: 'zoomDelta', delta: -0.1 });
        });
        document.getElementById('cppref-zoom-in')?.addEventListener('click', () => {
            postHostMessage({ type: 'zoomDelta', delta: 0.1 });
        });
    };

    if (document.body) inject();
    else window.addEventListener('DOMContentLoaded', inject, { once: true });
}

/**
 * In-webview back / forward navigation controls. Mirrors the
 * `cppDocs.back` / `cppDocs.forward` commands the host exposes,
 * giving the user a clickable affordance when they want to retrace
 * their steps after following a deep link.
 *
 * The buttons sit in a fixed overlay at the top-right of the
 * webview, paired styling-wise with the zoom controls so the chrome
 * stays consistent. They're rendered as left- and right-pointing
 * arrows; the host's commands no-op when there's nothing to
 * navigate to, so we don't need to plumb canGoBack/canGoForward
 * through the bootstrap data.
 */
function installNavControls(): void {
    const inject = (): void => {
        if (!document.body) return;
        if (document.getElementById('cppref-nav-controls')) return;
        const ctrl = document.createElement('div');
        ctrl.id = 'cppref-nav-controls';
        ctrl.className = 'cppref-nav-controls cppref-no-intercept';
        ctrl.innerHTML =
            '<button class="cppref-nav-btn" id="cppref-nav-back" title="Back (previously viewed page)" aria-label="Back">' +
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10.5 13.5L4.5 8l6-5.5v11z"/></svg>' +
            '</button>' +
            '<button class="cppref-nav-btn" id="cppref-nav-forward" title="Forward" aria-label="Forward">' +
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5.5 2.5L11.5 8l-6 5.5v-11z"/></svg>' +
            '</button>';
        document.body.appendChild(ctrl);

        document
            .getElementById('cppref-nav-back')
            ?.addEventListener('click', () => {
                postHostMessage({ type: 'runCommand', command: 'cppDocs.back' });
            });
        document
            .getElementById('cppref-nav-forward')
            ?.addEventListener('click', () => {
                postHostMessage({ type: 'runCommand', command: 'cppDocs.forward' });
            });
    };

    if (document.body) inject();
    else window.addEventListener('DOMContentLoaded', inject, { once: true });
}

/**
 * Single floating button that pops the docs panel out to an editor
 * tab when hosted in the sidebar view, and docks it back in the
 * sidebar when hosted in an editor tab. The host injects
 * `__cppref.surfaceKind` so we know which direction the button
 * should offer. Sits in the same top-right overlay strip as the
 * nav-controls for visual consistency.
 *
 * The actual surface move is atomic — see the
 * `cppDocs.moveToEditorTab` / `cppDocs.dockInSidebar` handlers in
 * `extension.ts`; this client just dispatches the command.
 */
function installLocationControl(): void {
    const inject = (): void => {
        if (!document.body) return;
        if (document.getElementById('cppref-location-control')) return;
        const surfaceKind = window.__cppref?.surfaceKind ?? 'view';
        const isView = surfaceKind === 'view';
        const command = isView ? 'cppDocs.moveToEditorTab' : 'cppDocs.dockInSidebar';
        const title = isView
            ? 'Move docs to an editor tab'
            : 'Dock docs in the side / bottom panel';
        const ariaLabel = isView ? 'Move to editor tab' : 'Dock in sidebar';
        // Two glyph variants — arrow-out (link-external) for pop-out;
        // arrow-into-box for dock. Inlined as SVG so they track
        // currentColor / theme without us shipping additional assets.
        const glyph = isView
            ? // outward diagonal arrow exiting a frame
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
            '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M9 2h5v5M14 2L8.5 7.5M13 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/>' +
            '</svg>'
            : // inward arrow into a frame on the left
            '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
            '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M2 2h5v12H2zM10 5l3 3-3 3M13 8H7"/>' +
            '</svg>';
        const btn = document.createElement('button');
        btn.id = 'cppref-location-control';
        btn.className = 'cppref-nav-btn cppref-location-btn cppref-no-intercept';
        btn.title = title;
        btn.setAttribute('aria-label', ariaLabel);
        btn.innerHTML = glyph;
        btn.addEventListener('click', () => {
            postHostMessage({ type: 'runCommand', command });
        });
        // Live in the same container as the back/forward buttons. If the
        // nav-controls strip exists, append into it; otherwise create a
        // standalone overlay that mirrors its position.
        const navStrip = document.getElementById('cppref-nav-controls');
        if (navStrip) {
            navStrip.appendChild(btn);
        } else {
            const ctrl = document.createElement('div');
            ctrl.id = 'cppref-nav-controls';
            ctrl.className = 'cppref-nav-controls cppref-no-intercept';
            ctrl.appendChild(btn);
            document.body.appendChild(ctrl);
        }
    };

    if (document.body) inject();
    else window.addEventListener('DOMContentLoaded', inject, { once: true });
}

function installHostMessageListener(): void {
    window.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as HostToClientMessage | undefined;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'setStandard' && typeof data.value === 'string') {
            if (document.body) document.body.dataset['cppStd'] = data.value;
            return;
        }
        if (
            data.type === 'setActive' &&
            typeof data.docsetId === 'number' &&
            typeof data.pagePath === 'string'
        ) {
            setActivePage(data.docsetId, data.pagePath);
            return;
        }
        if (data.type === 'setZoom' && typeof data.value === 'number') {
            applyZoom(data.value);
            return;
        }
        if (
            data.type === 'setCodeTheme' &&
            typeof data.themeId === 'string' &&
            typeof data.cssVars === 'string'
        ) {
            handleSetCodeTheme(data.themeId, data.cssVars);
        }
    });
}

// User-configurable visibility for each floating control. The host
// reads `cppDocs.controls.*` settings and emits the resolved values
// in the bootstrap data; we honor them by simply skipping the
// inject when the corresponding flag is false.
const controls = window.__cppref?.controls ?? {};
const showZoom = controls.showZoom !== false;
const showThemePicker = controls.showThemePicker !== false;
const showNavButtons = controls.showNavButtons !== false;

applyInitialStandard();
if (showZoom) installZoomControls();
if (showThemePicker) installCodeThemePicker();
if (showNavButtons) installNavControls();
// The location-move button always renders — it's the user's single
// affordance for relocating the panel and not part of an "optional
// chrome" group. Hiding it would orphan the dock/pop-out flow.
installLocationControl();
installNavListener();
installScrollPersistence();
installBreadcrumbAutoHide();
installHostMessageListener();
installToc();
function onDomReady(): void {
    // Correct base font size to match the editor before syntax highlighting
    // so that any reflow from the zoom adjustment happens before hljs touches
    // the DOM — avoids a double-layout pass.
    computeAndApplyBaseSizeCorrection();
    // Re-tokenize code blocks via highlight.js once the DOM is ready.
    // cppreference's stock GeSHi output is coarse (most operators and
    // identifiers render as plain text); highlight.js produces the full
    // `.hljs-keyword` / `.hljs-string` / ... class taxonomy that the
    // template CSS maps onto VSCode theme colors.
    applySyntaxHighlight();
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', onDomReady, { once: true });
} else {
    onDomReady();
}
postHostMessage({ type: 'ready' });
