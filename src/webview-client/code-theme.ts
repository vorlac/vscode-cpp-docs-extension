import { postHostMessage } from './state.js';

/**
 * In-panel base16 code-theme picker.
 *
 * The host injects `window.__cppref.codeThemes` (menu metadata) and
 * `window.__cppref.codeTheme` (active id) into the bootstrap payload,
 * and emits the active palette into `<style id="cppref-code-theme-vars">`
 * on first paint. The picker:
 *
 *   1. Builds a `<select>` populated from `codeThemes`, grouped into
 *      dark / light `<optgroup>`s.
 *   2. On change → posts `pickCodeTheme { themeId }` to the host.
 *      The host updates `cppDocs.codeTheme` (Global scope); a
 *      config-change watcher then broadcasts `setCodeTheme` to every
 *      open surface so panel + sidebar stay in sync.
 *   3. On `setCodeTheme` → replaces the textContent of the
 *      cppref-code-theme-vars `<style>` element so every code block
 *      recolors live (no re-render).
 *
 * Picker chrome lives inside the existing `.cppref-zoom-controls`
 * overlay so it shares the same low-opacity-until-hover behavior; no
 * new fixed-position container needed.
 */

const PICKER_ID = 'cppref-code-theme-picker';
const VARS_BLOCK_ID = 'cppref-code-theme-vars';

function findVarsBlock(): HTMLStyleElement | null {
    return document.getElementById(VARS_BLOCK_ID) as HTMLStyleElement | null;
}

function applyVars(cssVars: string): void {
    const block = findVarsBlock();
    if (!block) return;
    // Replace just the body of the :root { ... } declaration. We always
    // re-emit the wrapping selector — the host sends the variable list
    // without the brace pair, identical to the format produced by
    // `buildCodeThemeCssVars`.
    block.textContent = `:root { ${cssVars} }`;
}

function buildSelectMarkup(
    themes: ReadonlyArray<{ id: string; label: string; kind: 'dark' | 'light' }>,
    active: string | undefined
): string {
    const dark = themes.filter((t) => t.kind === 'dark');
    const light = themes.filter((t) => t.kind === 'light');
    const opt = (t: { id: string; label: string }): string => {
        const selected = t.id === active ? ' selected' : '';
        return `<option value="${escapeAttr(t.id)}"${selected}>${escapeText(t.label)}</option>`;
    };
    const groups: string[] = [];
    if (dark.length > 0) {
        groups.push(`<optgroup label="Dark">${dark.map(opt).join('')}</optgroup>`);
    }
    if (light.length > 0) {
        groups.push(`<optgroup label="Light">${light.map(opt).join('')}</optgroup>`);
    }
    return groups.join('');
}

function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function installCodeThemePicker(): void {
    const inject = (): void => {
        if (!document.body) return;
        if (document.getElementById(PICKER_ID)) return;
        const themes = window.__cppref?.codeThemes ?? [];
        if (themes.length === 0) return;
        const active = window.__cppref?.codeTheme;

        // The zoom-controls bar is the natural home for chrome that shares
        // the same hover-to-show pattern. If it doesn't exist yet (race
        // with `installZoomControls`), defer once via RAF and try again.
        const host = document.querySelector('.cppref-zoom-controls');
        if (!host) {
            // Don't poll indefinitely if zoom controls are disabled
            if (window.__cppref?.controls?.showZoom === false) return;
            requestAnimationFrame(inject);
            return;
        }

        const wrap = document.createElement('label');
        wrap.id = PICKER_ID;
        wrap.className = 'cppref-code-theme-picker cppref-no-intercept';
        wrap.title = 'Code snippet theme';
        wrap.innerHTML =
            '<span class="cppref-code-theme-glyph" aria-hidden="true">◐</span>' +
            `<select aria-label="Code snippet theme">${buildSelectMarkup(themes, active)}</select>`;
        host.insertBefore(wrap, host.firstChild);

        const select = wrap.querySelector('select');
        if (select instanceof HTMLSelectElement) {
            select.addEventListener('change', () => {
                const id = select.value;
                if (id) postHostMessage({ type: 'pickCodeTheme', themeId: id });
            });
        }
    };

    if (document.body) inject();
    else window.addEventListener('DOMContentLoaded', inject, { once: true });
}

/**
 * Handle a host-pushed `setCodeTheme`. Swaps the variables block and
 * syncs the picker's selected option to the new id (so an out-of-band
 * change — Settings UI, workspace settings edit — updates the picker
 * even when it wasn't the trigger).
 */
export function handleSetCodeTheme(themeId: string, cssVars: string): void {
    applyVars(cssVars);
    const picker = document.getElementById(PICKER_ID);
    const select = picker?.querySelector('select');
    if (select instanceof HTMLSelectElement && select.value !== themeId) {
        select.value = themeId;
    }
}
