// Unit tests for `src/docset/update-check.ts` (M6.2).
//
// Covers:
//   1. `compareCppreferenceVersions` — three-state comparator
//      (up-to-date / update-available / no-installation), including the
//      "installed is newer" downgrade-prompt suppression.
//   2. `evaluateUpdate` — globalState-backed dedup so the user is
//      prompted at most once per upstream version.
import { describe, it, expect, vi } from 'vitest';
import {
    compareCppreferenceVersions,
    evaluateUpdate,
    UPDATE_LAST_SEEN_KEY,
    type UpdateMemento
} from '../../src/docset/update-check.js';
import type { ReleaseInfo } from '../../src/docset/cppreference-installer.js';

function makeMemento(initial: Record<string, string> = {}): UpdateMemento & {
    store: Record<string, string | undefined>;
} {
    const store: Record<string, string | undefined> = { ...initial };
    return {
        store,
        get: (key) => store[key],
        update: async (key, value) => {
            store[key] = value;
        }
    };
}

function makeRelease(version: string): ReleaseInfo {
    return {
        tagName: version,
        version,
        assets: []
    };
}

describe('compareCppreferenceVersions', () => {
    it("returns 'update-available' when installed lags latest", () => {
        expect(compareCppreferenceVersions('20250209', '20250815')).toBe(
            'update-available'
        );
    });

    it("returns 'up-to-date' when installed equals latest", () => {
        expect(compareCppreferenceVersions('20250209', '20250209')).toBe(
            'up-to-date'
        );
    });

    it("returns 'up-to-date' when installed is newer than latest (no downgrade prompt)", () => {
        // Rare but possible if the GitHub Releases API returns a stale
        // entry, or if the user manually downgraded the upstream tag list.
        // We must not prompt the user to "update" backwards.
        expect(compareCppreferenceVersions('20260101', '20250815')).toBe(
            'up-to-date'
        );
    });

    it("returns 'no-installation' when no docset is installed", () => {
        expect(compareCppreferenceVersions(undefined, '20250815')).toBe(
            'no-installation'
        );
        expect(compareCppreferenceVersions('', '20250815')).toBe('no-installation');
    });

    it('strips a leading v from either side before comparing', () => {
        expect(compareCppreferenceVersions('v20250209', '20250815')).toBe(
            'update-available'
        );
        expect(compareCppreferenceVersions('20250209', 'v20250209')).toBe(
            'up-to-date'
        );
    });
});

describe('evaluateUpdate', () => {
    it('returns up-to-date with no prompt when versions match', async () => {
        const fetchLatest = vi.fn(async () => makeRelease('20250209'));
        const memento = makeMemento();
        const decision = await evaluateUpdate({
            installedVersion: '20250209',
            fetchLatest,
            memento
        });
        expect(decision.state).toBe('up-to-date');
        expect(decision.shouldPrompt).toBe(false);
        expect(memento.store[UPDATE_LAST_SEEN_KEY]).toBeUndefined();
    });

    it('returns update-available + shouldPrompt=true on first sight of a newer version', async () => {
        const fetchLatest = vi.fn(async () => makeRelease('20250815'));
        const memento = makeMemento();
        const decision = await evaluateUpdate({
            installedVersion: '20250209',
            fetchLatest,
            memento
        });
        expect(decision.state).toBe('update-available');
        expect(decision.latestVersion).toBe('20250815');
        expect(decision.shouldPrompt).toBe(true);
        // lastSeenVersion is persisted *before* the prompt fires so a
        // second activation in the same session doesn't re-prompt.
        expect(memento.store[UPDATE_LAST_SEEN_KEY]).toBe('20250815');
    });

    it('does not re-prompt for the same upstream tag (dedup via globalState)', async () => {
        const fetchLatest = vi.fn(async () => makeRelease('20250815'));
        const memento = makeMemento({
            [UPDATE_LAST_SEEN_KEY]: '20250815'
        });
        const decision = await evaluateUpdate({
            installedVersion: '20250209',
            fetchLatest,
            memento
        });
        expect(decision.state).toBe('update-available');
        expect(decision.shouldPrompt).toBe(false);
    });

    it('re-prompts when a *new* upstream tag arrives (dedup is per-version)', async () => {
        const fetchLatest = vi.fn(async () => makeRelease('20251001'));
        const memento = makeMemento({
            [UPDATE_LAST_SEEN_KEY]: '20250815'
        });
        const decision = await evaluateUpdate({
            installedVersion: '20250209',
            fetchLatest,
            memento
        });
        expect(decision.state).toBe('update-available');
        expect(decision.shouldPrompt).toBe(true);
        expect(memento.store[UPDATE_LAST_SEEN_KEY]).toBe('20251001');
    });

    it('swallows fetch errors and reports up-to-date with no prompt', async () => {
        const fetchLatest = vi.fn(async () => {
            throw new Error('network unreachable');
        });
        const memento = makeMemento();
        const decision = await evaluateUpdate({
            installedVersion: '20250209',
            fetchLatest,
            memento
        });
        expect(decision.state).toBe('up-to-date');
        expect(decision.shouldPrompt).toBe(false);
        expect(decision.latestVersion).toBeUndefined();
    });

    it('does not prompt when no docset is installed (welcome view handles that path)', async () => {
        const fetchLatest = vi.fn(async () => makeRelease('20250815'));
        const memento = makeMemento();
        const decision = await evaluateUpdate({
            installedVersion: undefined,
            fetchLatest,
            memento
        });
        expect(decision.state).toBe('no-installation');
        expect(decision.shouldPrompt).toBe(false);
        expect(memento.store[UPDATE_LAST_SEEN_KEY]).toBeUndefined();
    });
});
