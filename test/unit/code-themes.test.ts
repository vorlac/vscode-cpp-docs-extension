import { describe, expect, it } from 'vitest';
import {
    CODE_THEMES,
    DEFAULT_CODE_THEME_ID,
    buildCodeThemeCssVars,
    getCodeTheme,
    getCodeThemeMenuEntries
} from '../../src/webview-host/code-themes.js';

const HEX = /^#[0-9a-f]{6}$/i;

describe('code-themes registry', () => {
    it('ships exactly 30 themes (15 dark + 15 light)', () => {
        expect(CODE_THEMES).toHaveLength(30);
        const dark = CODE_THEMES.filter((t) => t.kind === 'dark');
        const light = CODE_THEMES.filter((t) => t.kind === 'light');
        expect(dark).toHaveLength(15);
        expect(light).toHaveLength(15);
    });

    it('exposes a default id that resolves', () => {
        expect(getCodeTheme(DEFAULT_CODE_THEME_ID).id).toBe(DEFAULT_CODE_THEME_ID);
    });

    it('falls back to the default on unknown / undefined ids', () => {
        expect(getCodeTheme(undefined).id).toBe(DEFAULT_CODE_THEME_ID);
        expect(getCodeTheme('does-not-exist').id).toBe(DEFAULT_CODE_THEME_ID);
        expect(getCodeTheme('').id).toBe(DEFAULT_CODE_THEME_ID);
    });

    it('has unique ids and labels across the registry', () => {
        const ids = new Set(CODE_THEMES.map((t) => t.id));
        const labels = new Set(CODE_THEMES.map((t) => t.label));
        expect(ids.size).toBe(CODE_THEMES.length);
        expect(labels.size).toBe(CODE_THEMES.length);
    });

    it('every palette has all 16 base16 slots as #rrggbb', () => {
        for (const theme of CODE_THEMES) {
            const slots = Object.entries(theme.palette);
            expect(slots).toHaveLength(16);
            for (const [slot, color] of slots) {
                expect(color, `${theme.id}.${slot}`).toMatch(HEX);
            }
        }
    });

    it('menu entries exclude palette data (small bootstrap payload)', () => {
        const entries = getCodeThemeMenuEntries();
        expect(entries).toHaveLength(CODE_THEMES.length);
        for (const e of entries) {
            expect(e).toEqual({ id: e.id, label: e.label, kind: e.kind });
            expect((e as unknown as { palette?: unknown }).palette).toBeUndefined();
        }
    });
});

describe('buildCodeThemeCssVars', () => {
    it('emits every hljs slot the template references', () => {
        const css = buildCodeThemeCssVars(getCodeTheme(DEFAULT_CODE_THEME_ID));
        const required = [
            '--cppref-hljs-bg',
            '--cppref-hljs-fg',
            '--cppref-hljs-selection',
            '--cppref-hljs-comment',
            '--cppref-hljs-number',
            '--cppref-hljs-string',
            '--cppref-hljs-keyword',
            '--cppref-hljs-type',
            '--cppref-hljs-title',
            '--cppref-hljs-variable',
            '--cppref-hljs-attribute'
        ];
        for (const v of required) {
            expect(css).toContain(`${v}:`);
        }
    });

    it('hybrid (default) preserves the prior token colors', () => {
        // The hybrid palette is meant to keep the pre-refactor look intact.
        // The base0E slot drives --cppref-hljs-keyword which is what users see
        // most often, so guard it specifically against accidental drift.
        const css = buildCodeThemeCssVars(getCodeTheme('hybrid'));
        expect(css).toContain('--cppref-hljs-keyword: #b294bb');
        expect(css).toContain('--cppref-hljs-string: #b5bd68');
        expect(css).toContain('--cppref-hljs-comment: #707880');
        expect(css).toContain('--cppref-hljs-bg: #1d1f21');
    });

    it('produces a distinct palette per theme', () => {
        const seen = new Set<string>();
        for (const t of CODE_THEMES) {
            seen.add(buildCodeThemeCssVars(t));
        }
        expect(seen.size).toBe(CODE_THEMES.length);
    });
});
