import { describe, expect, it } from 'vitest';
import { SurfaceManager } from '../../src/ui/surface/manager.js';
import { NavigationHistory } from '../../src/ui/surface/navigation.js';

type AnyView = { visible: boolean };
type AnyPanel = { visible: boolean };

function makeView(visible = true): AnyView {
    return { visible };
}

function makePanel(visible = true): AnyPanel {
    return { visible };
}

// Single-instance is enforced at the command layer (move-to-editor /
// dock-in-sidebar dispose the source before attaching the destination),
// so in production exactly one of `attachView` / `attachPanel` is
// active at any time. Tests still exercise the dual-attached shape to
// verify `pickTarget` stays well-defined under any input — it should
// never throw or return both.

describe('SurfaceManager.pickTarget', () => {
    it('returns undefined when neither surface is attached', () => {
        const m = new SurfaceManager();
        expect(m.pickTarget()).toBeUndefined();
    });

    it('returns "view" when only the view is attached', () => {
        const m = new SurfaceManager();
        m.attachView(makeView(false) as never);
        expect(m.pickTarget()).toBe('view');
        m.detachView();
        m.attachView(makeView(true) as never);
        expect(m.pickTarget()).toBe('view');
    });

    it('returns "panel" when only the panel is attached', () => {
        const m = new SurfaceManager();
        m.attachPanel(makePanel(false) as never);
        expect(m.pickTarget()).toBe('panel');
    });

    it('prefers the view side when (defensively) both are attached', () => {
        // Single-instance is a user-facing invariant maintained by the
        // command layer, not the manager. If both ever end up attached
        // (programmer error, race during a move), prefer the view so the
        // older surface kind wins deterministically — the command will
        // immediately follow up with a `detachView` from the move-to-
        // editor command and the state settles.
        const m = new SurfaceManager();
        m.attachView(makeView(true) as never);
        m.attachPanel(makePanel(true) as never);
        expect(m.pickTarget()).toBe('view');
    });

    it('falls through to "panel" after detachView when both were attached', () => {
        const m = new SurfaceManager();
        m.attachView(makeView(true) as never);
        m.attachPanel(makePanel(true) as never);
        m.detachView();
        expect(m.pickTarget()).toBe('panel');
    });

    it('returns undefined again after both are detached', () => {
        const m = new SurfaceManager();
        m.attachView(makeView(true) as never);
        m.detachView();
        expect(m.pickTarget()).toBeUndefined();
    });
});

describe('SurfaceManager — accessors', () => {
    it('hasView/hasPanel reflect attach/detach', () => {
        const m = new SurfaceManager();
        expect(m.hasView()).toBe(false);
        expect(m.hasPanel()).toBe(false);

        m.attachView(makeView() as never);
        m.attachPanel(makePanel() as never);
        expect(m.hasView()).toBe(true);
        expect(m.hasPanel()).toBe(true);

        m.detachView();
        expect(m.hasView()).toBe(false);
        expect(m.hasPanel()).toBe(true);
    });

    it('getView/getPanel return the attached references', () => {
        const m = new SurfaceManager();
        const v = makeView();
        const p = makePanel();
        m.attachView(v as never);
        m.attachPanel(p as never);
        expect(m.getView()).toBe(v);
        expect(m.getPanel()).toBe(p);
    });

});

// Fix A (iter 37) — `getViewHistory` / `getPanelHistory` expose the
// per-surface navigation history so `resolveWebviewView` (and the
// panel's create/rehydrate paths) can hand the same history back to a
// future re-resolve. Without retention across `detachView` /
// `attachView` cycles, a sidebar collapse or focus transition with
// `retainContextWhenHidden: false` would clobber the active NavTarget
// and the next cursor-follow update would land on a fresh, empty view.
describe('SurfaceManager — history retention across attach/detach', () => {
    it('getViewHistory / getPanelHistory return undefined before attach', () => {
        const m = new SurfaceManager();
        expect(m.getViewHistory()).toBeUndefined();
        expect(m.getPanelHistory()).toBeUndefined();
    });

    it('getViewHistory returns the history passed to attachView', () => {
        const m = new SurfaceManager();
        const history = new NavigationHistory();
        history.push({ docsetId: 1, pagePath: 'a.html' });
        m.attachView(makeView() as never, history);
        expect(m.getViewHistory()).toBe(history);
        expect(m.getViewHistory()?.current()).toEqual({
            docsetId: 1,
            pagePath: 'a.html'
        });
    });

    it('getViewHistory survives detachView (retained across re-resolve cycles)', () => {
        const m = new SurfaceManager();
        const history = new NavigationHistory();
        history.push({ docsetId: 1, pagePath: 'a.html' });
        m.attachView(makeView() as never, history);
        m.detachView();
        expect(m.hasView()).toBe(false);
        expect(m.getViewHistory()).toBe(history);
        expect(m.getViewHistory()?.current()).toEqual({
            docsetId: 1,
            pagePath: 'a.html'
        });
    });

    it('getPanelHistory returns the history passed to attachPanel and survives detachPanel', () => {
        const m = new SurfaceManager();
        const history = new NavigationHistory();
        history.push({ docsetId: 2, pagePath: 'b.html' });
        m.attachPanel(makePanel() as never, history);
        expect(m.getPanelHistory()).toBe(history);
        m.detachPanel();
        expect(m.hasPanel()).toBe(false);
        expect(m.getPanelHistory()).toBe(history);
    });

    it('re-attach with the existing history keeps current() intact', () => {
        const m = new SurfaceManager();
        const history = new NavigationHistory();
        history.push({ docsetId: 1, pagePath: 'first.html' });
        m.attachView(makeView() as never, history);
        m.detachView();
        const existing = m.getViewHistory();
        expect(existing).toBeDefined();
        m.attachView(makeView() as never, existing!);
        expect(m.getViewHistory()?.current()).toEqual({
            docsetId: 1,
            pagePath: 'first.html'
        });
    });

    it('attachView with a fresh history replaces the retained one', () => {
        const m = new SurfaceManager();
        const old = new NavigationHistory();
        old.push({ docsetId: 1, pagePath: 'old.html' });
        m.attachView(makeView() as never, old);
        m.detachView();

        const fresh = new NavigationHistory();
        fresh.push({ docsetId: 1, pagePath: 'new.html' });
        m.attachView(makeView() as never, fresh);
        expect(m.getViewHistory()).toBe(fresh);
        expect(m.getViewHistory()?.current()).toEqual({
            docsetId: 1,
            pagePath: 'new.html'
        });
    });
});

// `adoptPanelHistoryToView` / `adoptViewHistoryToPanel` underpin the
// atomic surface-move commands. Moving from sidebar to editor copies
// the view's history onto the panel slot before the dispose; the
// reverse direction copies the panel's history onto the view slot.
// Both methods must be no-ops when the source history is absent.
describe('SurfaceManager — history adoption for atomic moves', () => {
    it('adoptViewHistoryToPanel copies the view history onto the panel slot', () => {
        const m = new SurfaceManager();
        const view = new NavigationHistory();
        view.push({ docsetId: 1, pagePath: 'cpp/algorithm/sort.html' });
        m.attachView(makeView() as never, view);
        m.adoptViewHistoryToPanel();
        expect(m.getPanelHistory()).toBe(view);
        expect(m.getPanelHistory()?.current()?.pagePath).toBe(
            'cpp/algorithm/sort.html'
        );
    });

    it('adoptPanelHistoryToView copies the panel history onto the view slot', () => {
        const m = new SurfaceManager();
        const panel = new NavigationHistory();
        panel.push({ docsetId: 2, pagePath: 'cpp/container/vector.html' });
        m.attachPanel(makePanel() as never, panel);
        m.adoptPanelHistoryToView();
        expect(m.getViewHistory()).toBe(panel);
    });

    it('adoptViewHistoryToPanel is a no-op when the view history is absent', () => {
        const m = new SurfaceManager();
        m.adoptViewHistoryToPanel();
        expect(m.getPanelHistory()).toBeUndefined();
    });

    it('adoptPanelHistoryToView is a no-op when the panel history is absent', () => {
        const m = new SurfaceManager();
        m.adoptPanelHistoryToView();
        expect(m.getViewHistory()).toBeUndefined();
    });
});

describe('SurfaceManager — C-2 stale-resource detection', () => {
    it('viewIsStale returns false when the view covers all installed docsets', () => {
        const m = new SurfaceManager();
        m.attachView(makeView() as never, undefined, [1, 2]);
        expect(m.viewIsStale([1, 2])).toBe(false);
    });

    it('viewIsStale returns true when an installed docset is missing from the resource set', () => {
        const m = new SurfaceManager();
        m.attachView(makeView() as never, undefined, [1]);
        expect(m.viewIsStale([1, 2])).toBe(true);
    });

    it('viewIsStale returns false when no view is attached', () => {
        const m = new SurfaceManager();
        expect(m.viewIsStale([1])).toBe(false);
    });

    it('panelIsStale mirrors viewIsStale for the editor-tab panel', () => {
        const m = new SurfaceManager();
        m.attachPanel(makePanel() as never, undefined, [1]);
        expect(m.panelIsStale([1])).toBe(false);
        expect(m.panelIsStale([1, 2])).toBe(true);
    });
});
