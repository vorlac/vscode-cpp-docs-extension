import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
);

/**
 * M6.5 — marketplace metadata + icon validation.
 *
 * `vsce package` will refuse to publish without `icon`, `categories`,
 * `repository`, and a non-empty `description`. We assert the contract here
 * so a regression in `package.json` is caught at `npm test` time, not at
 * the moment of release.
 */
describe('marketplace metadata', () => {
    it('declares an icon path that points at an existing file', () => {
        expect(typeof pkg.icon).toBe('string');
        expect(pkg.icon.length).toBeGreaterThan(0);
        const iconPath = path.join(repoRoot, pkg.icon);
        expect(fs.existsSync(iconPath)).toBe(true);
        // The asset must exist with non-zero bytes — `vsce` blindly copies it
        // into the .vsix and the marketplace serves a 0-byte 200 if we don't.
        const stat = fs.statSync(iconPath);
        expect(stat.size).toBeGreaterThan(0);
    });

    it('icon is a 128x128 PNG (marketplace requirement)', () => {
        const iconPath = path.join(repoRoot, pkg.icon);
        const buf = fs.readFileSync(iconPath);
        // PNG signature + IHDR chunk: bytes 0..7 are the signature; 8..11 are
        // the IHDR length (always 13); 12..15 are the chunk type 'IHDR';
        // 16..19 are width (BE u32); 20..23 are height (BE u32).
        expect(buf.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        expect(width).toBeGreaterThanOrEqual(128);
        expect(height).toBeGreaterThanOrEqual(128);
    });

    it('declares categories including "Programming Languages"', () => {
        expect(Array.isArray(pkg.categories)).toBe(true);
        expect(pkg.categories).toContain('Programming Languages');
        // Marketplace uses a closed set — ensure every entry is from the
        // documented list (most projects ship with one or two; the list is
        // small enough to inline). See
        // https://code.visualstudio.com/api/references/extension-manifest
        const allowed = new Set([
            'AI',
            'Azure',
            'Chat',
            'Data Science',
            'Debuggers',
            'Education',
            'Extension Packs',
            'Formatters',
            'Keymaps',
            'Language Packs',
            'Linters',
            'Machine Learning',
            'Notebooks',
            'Other',
            'Programming Languages',
            'SCM Providers',
            'Snippets',
            'Testing',
            'Themes',
            'Visualization'
        ]);
        for (const c of pkg.categories) {
            expect(
                allowed.has(c),
                `category "${c}" is not in the marketplace's closed-list`
            ).toBe(true);
        }
    });

    it('declares a non-empty keywords array', () => {
        expect(Array.isArray(pkg.keywords)).toBe(true);
        expect(pkg.keywords.length).toBeGreaterThan(0);
        for (const k of pkg.keywords) {
            expect(typeof k).toBe('string');
            expect(k.length).toBeGreaterThan(0);
        }
        // Domain-specific anchors that gate marketplace discoverability for
        // C/C++ developers. If any of these regress the extension stops
        // surfacing under the relevant searches.
        expect(pkg.keywords).toContain('cppreference');
        expect(pkg.keywords).toContain('cpp');
    });

    it('declares a repository (url or TODO marker)', () => {
        // Two acceptable shapes: a `{ type, url }` object, or a string. Both
        // must include either a real http(s) URL or a literal `TODO(release)`
        // marker so a reviewer can grep for it before publish.
        const repo = pkg.repository;
        expect(repo).toBeDefined();
        const url =
            typeof repo === 'string'
                ? repo
                : typeof repo?.url === 'string'
                    ? repo.url
                    : '';
        expect(url.length).toBeGreaterThan(0);
        const looksLikeUrl = /^https?:\/\//.test(url);
        const isTodo = url.includes('TODO');
        expect(
            looksLikeUrl || isTodo,
            `repository url "${url}" must be an http(s) URL or include TODO(release) marker`
        ).toBe(true);
    });

    it('description is non-empty and under 100 characters', () => {
        expect(typeof pkg.description).toBe('string');
        expect(pkg.description.length).toBeGreaterThan(0);
        expect(pkg.description.length).toBeLessThan(100);
    });

    it('publisher is set', () => {
        expect(typeof pkg.publisher).toBe('string');
        expect(pkg.publisher.length).toBeGreaterThan(0);
    });

    it('license is MIT and LICENSE file exists at the project root', () => {
        expect(pkg.license).toBe('MIT');
        const licensePath = path.join(repoRoot, 'LICENSE');
        expect(fs.existsSync(licensePath)).toBe(true);
        const text = fs.readFileSync(licensePath, 'utf8');
        expect(text).toMatch(/MIT License/);
    });

    it('every contributed command has a non-empty title (M6.1 dup, OK)', () => {
        const cmds: { command: string; title?: string }[] =
            pkg.contributes?.commands ?? [];
        expect(cmds.length).toBeGreaterThan(0);
        for (const c of cmds) {
            expect(
                typeof c.title === 'string' && c.title.trim().length > 0,
                `command "${c.command}" is missing a title`
            ).toBe(true);
        }
    });

    it('every configuration property has a non-empty description (M6.1 dup, OK)', () => {
        const props = pkg.contributes?.configuration?.properties ?? {};
        const keys = Object.keys(props);
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) {
            const prop = props[key];
            const desc: unknown =
                (typeof prop.description === 'string' ? prop.description : '') ||
                (typeof prop.markdownDescription === 'string'
                    ? prop.markdownDescription
                    : '');
            expect(
                typeof desc === 'string' && (desc as string).trim().length > 0,
                `cppDocs setting "${key}" is missing a description / markdownDescription`
            ).toBe(true);
        }
    });

    it('galleryBanner declares a color and theme', () => {
        // Optional per the marketplace spec, but if present both fields must
        // be set — half-populated banners render with default chrome.
        if (!pkg.galleryBanner) return;
        expect(typeof pkg.galleryBanner.color).toBe('string');
        expect(['light', 'dark']).toContain(pkg.galleryBanner.theme);
    });
});
