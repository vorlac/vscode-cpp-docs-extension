import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

describe('package.json contract', () => {
    it('declares vscode engine ^1.95.0', () => {
        expect(pkg.engines?.vscode).toBe('^1.95.0');
    });

    it('points main at the host bundle', () => {
        expect(pkg.main).toBe('./dist/host/extension.js');
    });

    it('declares the M0/M1 commands (openSymbol + install/remove/update)', () => {
        const ids: string[] = (pkg.contributes?.commands ?? []).map(
            (c: { command: string }) => c.command
        );
        for (const expected of [
            'cppDocs.openSymbol',
            'cppDocs.installCppreference',
            'cppDocs.checkForUpdates',
            'cppDocs.removeDocset'
        ]) {
            expect(ids).toContain(expected);
        }
    });

    // Fix B (iter 37) — `cppDocs.showOutput` opens the diagnostic
    // OutputChannel for users who can't find it via View → Output.
    // Pinned in the contract so a future package.json edit can't drop
    // the entry without flagging the tests.
    it('declares the cppDocs.showOutput command (Fix B diagnostic channel)', () => {
        const ids: string[] = (pkg.contributes?.commands ?? []).map(
            (c: { command: string }) => c.command
        );
        expect(ids).toContain('cppDocs.showOutput');
        const entry = (pkg.contributes?.commands ?? []).find(
            (c: { command: string }) => c.command === 'cppDocs.showOutput'
        );
        expect(entry?.title).toBe('C++ Docs: Show Output Channel');
    });

    it('declares onLanguage activation events for cpp and c', () => {
        const events: string[] = pkg.activationEvents ?? [];
        expect(events).toContain('onLanguage:cpp');
        expect(events).toContain('onLanguage:c');
    });

    it('declares the cppDocsetsBrowser activity-bar viewsContainer with a media icon', () => {
        const containers = pkg.contributes?.viewsContainers?.activitybar ?? [];
        const container = containers.find(
            (c: { id: string }) => c.id === 'cppDocsetsBrowser'
        );
        expect(container).toBeDefined();
        expect(container.icon).toMatch(/\.svg$/);
        expect(container.title).toBe('C/C++ Docset Browser');
        // First (and only) entry — keeps the activity-bar contract focused.
        expect(pkg.contributes?.viewsContainers?.activitybar?.[0]?.id).toBe(
            'cppDocsetsBrowser'
        );
    });

    it('declares the cppDocsViewerPanel secondary-sidebar viewsContainer (default location for the doc panel)', () => {
        const containers = pkg.contributes?.viewsContainers?.secondarySidebar ?? [];
        const container = containers.find(
            (c: { id: string }) => c.id === 'cppDocsViewerPanel'
        );
        expect(container).toBeDefined();
        expect(container.title).toBe('C/C++ Docs');
        expect(container.icon).toMatch(/\.svg$/);
        expect(pkg.contributes?.viewsContainers?.secondarySidebar?.[0]?.id).toBe(
            'cppDocsViewerPanel'
        );
    });

    it('declares the search view and docset tree view in the cppDocsetsBrowser activity-bar container', () => {
        const views = pkg.contributes?.views?.cppDocsetsBrowser ?? [];
        expect(views).toHaveLength(2);
        const searchView = views.find((v: { id: string }) => v.id === 'cppDocs.searchView');
        const treeView = views.find((v: { id: string }) => v.id === 'cppDocs.docsetTree');
        expect(searchView).toBeDefined();
        expect(treeView).toBeDefined();
    });

    // Fix A — the tree view's `when` clause binds the contribution to
    // `cppDocs.tree.enabled`. With the setting at false, VSCode does not
    // contribute the view at all (no "no data provider" error, no empty
    // container). The runtime guard in `extension.ts` was removed in
    // favor of this declarative gate.
    it('gates the docset tree view on cppDocs.tree.enabled via a when clause', () => {
        const views = pkg.contributes?.views?.cppDocsetsBrowser ?? [];
        const treeView = views.find((v: { id: string }) => v.id === 'cppDocs.docsetTree');
        expect(treeView?.when).toBe('config.cppDocs.tree.enabled');
    });

    it('contributes the cppDocs.docPanel webview view to the secondary-sidebar cppDocsViewerPanel container', () => {
        const views = pkg.contributes?.views?.cppDocsViewerPanel ?? [];
        expect(views).toHaveLength(1);
        const docPanel = views[0];
        expect(docPanel.id).toBe('cppDocs.docPanel');
        expect(docPanel.type).toBe('webview');
        expect(docPanel.contextualTitle).toBe('C/C++ Docs');
    });

    // Atomic move commands replace the older `cppDocs.openInEditorTab`:
    // `moveToEditorTab` pops the sidebar instance over to an editor tab
    // (disposing any prior panel); `dockInSidebar` does the reverse.
    // Single-instance is enforced at the command layer by toggling the
    // `cppDocs.location` setContext key that gates the sidebar view's
    // `when` clause in package.json.
    it('declares cppDocs.moveToEditorTab and cppDocs.dockInSidebar commands', () => {
        const ids: string[] = (pkg.contributes?.commands ?? []).map(
            (c: { command: string }) => c.command
        );
        expect(ids).toContain('cppDocs.moveToEditorTab');
        expect(ids).toContain('cppDocs.dockInSidebar');
    });

    it('does NOT declare the removed cppDocs.openInEditorTab command', () => {
        // The historic open-in-editor-tab command was confusing because
        // it created a SECOND surface alongside the sidebar view, leaving
        // the user with a stale sidebar that would never get focus
        // updates. The new move commands replace it.
        const ids: string[] = (pkg.contributes?.commands ?? []).map(
            (c: { command: string }) => c.command
        );
        expect(ids).not.toContain('cppDocs.openInEditorTab');
    });

    it('gates the sidebar doc-panel view on cppDocs.location != editor', () => {
        // The setContext key drives single-instance: when the user moves
        // the docs to an editor tab we set the key to 'editor', which
        // hides the sidebar contribution entirely. Without this, the
        // sidebar view would re-attach and we'd be back to two-surface.
        const views = pkg.contributes?.views?.cppDocsViewerPanel ?? [];
        const docPanel = views[0];
        expect(docPanel.when).toBe("cppDocs.location != 'editor'");
    });

    it('does NOT declare the removed cppDocs.panel.primarySurface setting', () => {
        const props = pkg.contributes?.configuration?.properties ?? {};
        expect(props['cppDocs.panel.primarySurface']).toBeUndefined();
    });

    it('declares cppDocs.setCppStandard command (M2.5 quick pick)', () => {
        const ids: string[] = (pkg.contributes?.commands ?? []).map(
            (c: { command: string }) => c.command
        );
        expect(ids).toContain('cppDocs.setCppStandard');
    });

    it('declares cppDocs.cppStandard configuration (auto + selectable standards)', () => {
        const props = pkg.contributes?.configuration?.properties ?? {};
        const setting = props['cppDocs.cppStandard'];
        expect(setting).toBeDefined();
        expect(setting.type).toBe('string');
        expect(setting.default).toBe('auto');
        expect(setting.enum).toEqual([
            'auto',
            'c++11',
            'c++14',
            'c++17',
            'c++20',
            'c++23',
            'c++26'
        ]);
    });

    it('declares cppDocs.cppStandard.fallback configuration (c++11..c++26, default c++20)', () => {
        const props = pkg.contributes?.configuration?.properties ?? {};
        const setting = props['cppDocs.cppStandard.fallback'];
        expect(setting).toBeDefined();
        expect(setting.type).toBe('string');
        expect(setting.default).toBe('c++20');
        expect(setting.enum).toEqual([
            'c++11',
            'c++14',
            'c++17',
            'c++20',
            'c++23',
            'c++26'
        ]);
    });

    it('declares cppDocs.back / cppDocs.forward navigation commands (M2.6 history)', () => {
        const ids: string[] = (pkg.contributes?.commands ?? []).map(
            (c: { command: string }) => c.command
        );
        expect(ids).toContain('cppDocs.back');
        expect(ids).toContain('cppDocs.forward');
    });

    it('declares onWebviewPanel:cppDocs.viewer activation event (serializer revival)', () => {
        const events: string[] = pkg.activationEvents ?? [];
        expect(events).toContain('onWebviewPanel:cppDocs.viewer');
    });

    it('declares cppDocs.attribution.enabled boolean configuration (default true)', () => {
        const props = pkg.contributes?.configuration?.properties ?? {};
        const setting = props['cppDocs.attribution.enabled'];
        expect(setting).toBeDefined();
        expect(setting.type).toBe('boolean');
        expect(setting.default).toBe(true);
    });

    it('declares cppDocs.openCurrentInBrowser command (M5.2 hover/external link)', () => {
        const ids: string[] = (pkg.contributes?.commands ?? []).map(
            (c: { command: string }) => c.command
        );
        expect(ids).toContain('cppDocs.openCurrentInBrowser');
    });

    it('declares cppDocs.hover.enabled boolean configuration (default true)', () => {
        const props = pkg.contributes?.configuration?.properties ?? {};
        const setting = props['cppDocs.hover.enabled'];
        expect(setting).toBeDefined();
        expect(setting.type).toBe('boolean');
        expect(setting.default).toBe(true);
    });

    it('does NOT declare the removed cppDocs.hover.snippetMaxChars setting', () => {
        // The hover provider now defaults to the full snippet length so
        // it matches the docs panel content. The truncation cap setting
        // was removed; tests still exercise truncation by injecting a
        // finite `maxChars` directly into the provider deps.
        const props = pkg.contributes?.configuration?.properties ?? {};
        expect(props['cppDocs.hover.snippetMaxChars']).toBeUndefined();
    });

    it('declares cppDocs.controls.show* visibility toggles (all default true)', () => {
        const props = pkg.contributes?.configuration?.properties ?? {};
        for (const key of [
            'cppDocs.controls.showZoom',
            'cppDocs.controls.showThemePicker',
            'cppDocs.controls.showNavButtons'
        ]) {
            const setting = props[key];
            expect(setting, `missing setting ${key}`).toBeDefined();
            expect(setting.type).toBe('boolean');
            expect(setting.default).toBe(true);
        }
    });

    // M6.1 — every spec key from docs/02-architecture.md "Configuration keys"
    // must exist in the package contribution block so the Settings UI exposes
    // it, even when the runtime defaults the value internally.
    it('declares the M6.1 spec configuration keys (panel.enabled, docsetsRoot, cppreference.version/checkForUpdates, theme.respectVSCodeTheme)', () => {
        const props = pkg.contributes?.configuration?.properties ?? {};
        const expectedKeys = [
            'cppDocs.panel.enabled',
            'cppDocs.docsetsRoot',
            'cppDocs.cppreference.version',
            'cppDocs.cppreference.checkForUpdates',
            'cppDocs.theme.respectVSCodeTheme'
        ];
        for (const k of expectedKeys) {
            expect(props[k]).toBeDefined();
        }
        expect(props['cppDocs.panel.enabled'].type).toBe('boolean');
        expect(props['cppDocs.panel.enabled'].default).toBe(true);
        expect(props['cppDocs.docsetsRoot'].type).toBe('string');
        expect(props['cppDocs.cppreference.version'].type).toBe('string');
        expect(props['cppDocs.cppreference.version'].default).toBe('latest');
        expect(props['cppDocs.cppreference.checkForUpdates'].type).toBe('boolean');
        expect(props['cppDocs.cppreference.checkForUpdates'].default).toBe(true);
        expect(props['cppDocs.theme.respectVSCodeTheme'].type).toBe('boolean');
        expect(props['cppDocs.theme.respectVSCodeTheme'].default).toBe(true);
    });

    it('every configuration property has a non-empty description (or markdownDescription)', () => {
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
                typeof desc === 'string' && desc.trim().length > 0,
                `cppDocs setting '${key}' is missing a description / markdownDescription`
            ).toBe(true);
        }
    });

    it('every configuration property declaring an enum also provides matching enumDescriptions', () => {
        const props = pkg.contributes?.configuration?.properties ?? {};
        for (const key of Object.keys(props)) {
            const prop = props[key];
            if (!Array.isArray(prop.enum)) continue;
            expect(
                Array.isArray(prop.enumDescriptions),
                `cppDocs setting '${key}' has an enum but no enumDescriptions`
            ).toBe(true);
            expect(
                prop.enumDescriptions.length,
                `cppDocs setting '${key}': enumDescriptions length must match enum length`
            ).toBe(prop.enum.length);
            for (const ed of prop.enumDescriptions) {
                expect(
                    typeof ed === 'string' && ed.trim().length > 0,
                    `cppDocs setting '${key}' has an empty enumDescription entry`
                ).toBe(true);
            }
        }
    });
});
