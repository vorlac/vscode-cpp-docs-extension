// cppreference update-check helpers (M6.2).
//
// Two pure functions plus a small orchestration entry point. The pure
// pieces are unit-tested directly; the orchestration is wired from
// `extension.ts` against a fully stubbed dependency surface so the
// activation path doesn't require mocking GitHub.
//
// Per docs/05-plan.md M6 ("Update notification: when a new cppreference
// version is detected, status-bar item invites the user to update").

import type { Fetcher, ReleaseInfo } from './cppreference-installer.js';
import { fetchLatestRelease } from './cppreference-installer.js';

export type UpdateState = 'up-to-date' | 'update-available' | 'no-installation';

/**
 * Compare two cppreference release tags. cppreference uses date-stamp
 * versions (`YYYYMMDD`, occasionally with a trailing letter or `-N`
 * suffix). We compare lexicographically after stripping a leading `v`,
 * which works for the date-stamp shape; for the rare suffixed releases
 * (e.g. `20250209a`) lexicographic order still matches release order
 * because cppreference always increments monotonically.
 *
 * Edge cases:
 * - When `installed` is undefined or empty → `no-installation`.
 * - When `installed` lexically beats `latest` (rare; can happen if the
 *   user manually downgrades the upstream tag list, or if the GitHub
 *   Releases API briefly returns a stale entry) → `up-to-date` rather
 *   than nagging the user to "update" backwards.
 */
export function compareCppreferenceVersions(
    installed: string | undefined,
    latest: string
): UpdateState {
    if (!installed || installed.length === 0) return 'no-installation';
    const norm = (s: string): string => s.replace(/^v/i, '');
    const a = norm(installed);
    const b = norm(latest);
    if (a === b) return 'up-to-date';
    return a < b ? 'update-available' : 'up-to-date';
}

/**
 * Minimal contract over `vscode.Memento` so `extension.ts` and tests
 * share an interface without dragging the full vscode types in.
 */
export interface UpdateMemento {
    get(key: string): string | undefined;
    update(key: string, value: string | undefined): Promise<void>;
}

/**
 * Decision output from `evaluateUpdate`. The orchestrator consumes this
 * to drive (a) the status-bar item and (b) the optional one-time
 * `showInformationMessage` prompt.
 */
export interface UpdateDecision {
    state: UpdateState;
    /** Latest tag pulled from GitHub (or undefined if the fetch failed silently). */
    latestVersion?: string;
    /** Whether the user should be prompted via showInformationMessage. */
    shouldPrompt: boolean;
}

const LAST_SEEN_KEY = 'cppDocs.cppreference.lastSeenVersion';

/**
 * Evaluate the update state and decide whether a prompt should fire,
 * deduplicating against the `lastSeenVersion` stored in `globalState`.
 *
 * Side effect: when an update is available, this writes the new tag
 * into `lastSeenVersion` *before* the prompt fires so a follow-up
 * activation in the same session doesn't re-prompt. Tests inject a
 * stubbed memento to assert this directly.
 *
 * `installedVersion === undefined` means "no cppreference docset
 * installed"; we still fetch the latest tag (so the status bar can
 * reflect "update available" the moment the user installs *anything*),
 * but we never prompt about a missing install — the welcome view
 * already handles that path.
 */
export async function evaluateUpdate(deps: {
    installedVersion: string | undefined;
    fetcher?: Fetcher;
    /**
     * Inject the release fetcher for tests so the network is never
     * touched. Defaults to `fetchLatestRelease`.
     */
    fetchLatest?: (fetcher?: Fetcher) => Promise<ReleaseInfo>;
    memento: UpdateMemento;
}): Promise<UpdateDecision> {
    const fetchLatest = deps.fetchLatest ?? fetchLatestRelease;
    let release: ReleaseInfo;
    try {
        release = await fetchLatest(deps.fetcher);
    } catch {
        // Activation must never block on a flaky network. Returning a
        // benign "up-to-date with no version" lets the orchestrator skip
        // the status-bar mutation and the prompt.
        return { state: 'up-to-date', shouldPrompt: false };
    }

    const state = compareCppreferenceVersions(deps.installedVersion, release.version);
    if (state !== 'update-available') {
        return { state, latestVersion: release.version, shouldPrompt: false };
    }

    const lastSeen = deps.memento.get(LAST_SEEN_KEY);
    const shouldPrompt = lastSeen !== release.version;
    if (shouldPrompt) {
        // Persist before the caller shows the dialog so dismissal vs.
        // accept doesn't matter — both count as "user has seen this
        // version".
        await deps.memento.update(LAST_SEEN_KEY, release.version);
    }
    return { state, latestVersion: release.version, shouldPrompt };
}

export const UPDATE_LAST_SEEN_KEY = LAST_SEEN_KEY;
