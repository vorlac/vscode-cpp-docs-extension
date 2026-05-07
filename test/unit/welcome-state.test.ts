import { describe, expect, it } from 'vitest';
import { refreshWelcomeState } from '../../src/ui/welcome-state.js';

function makeRecorder(): {
    calls: Array<[string, unknown]>;
    setContext: (k: string, v: boolean | string) => Promise<void>;
} {
    const calls: Array<[string, unknown]> = [];
    const setContext = async (k: string, v: boolean | string): Promise<void> => {
        calls.push([k, v]);
    };
    return { calls, setContext };
}

describe('refreshWelcomeState', () => {
    it('sets cppDocs.hasDocsets=true when hasAnyDocset() returns true', async () => {
        const { calls, setContext } = makeRecorder();

        await refreshWelcomeState({
            setContext,
            hasAnyDocset: () => true
        });

        expect(calls).toEqual([['cppDocs.hasDocsets', true]]);
    });

    it('sets cppDocs.hasDocsets=false when hasAnyDocset() returns false', async () => {
        const { calls, setContext } = makeRecorder();

        await refreshWelcomeState({
            setContext,
            hasAnyDocset: () => false
        });

        expect(calls).toEqual([['cppDocs.hasDocsets', false]]);
    });

    it('issues a setContext call on every refresh (no caching/dedup)', async () => {
        const { calls, setContext } = makeRecorder();
        let docsetPresent = false;
        const deps = {
            setContext,
            hasAnyDocset: () => docsetPresent
        };

        await refreshWelcomeState(deps);
        await refreshWelcomeState(deps);
        docsetPresent = true;
        await refreshWelcomeState(deps);
        docsetPresent = false;
        await refreshWelcomeState(deps);

        expect(calls).toEqual([
            ['cppDocs.hasDocsets', false],
            ['cppDocs.hasDocsets', false],
            ['cppDocs.hasDocsets', true],
            ['cppDocs.hasDocsets', false]
        ]);
    });

    it('sets cppDocs.canResolve when canResolve callback is provided', async () => {
        const { calls, setContext } = makeRecorder();

        await refreshWelcomeState({
            setContext,
            hasAnyDocset: () => true,
            canResolve: () => true
        });

        expect(calls).toEqual([
            ['cppDocs.hasDocsets', true],
            ['cppDocs.canResolve', true]
        ]);
    });

    it('reflects canResolve()=false through the context key', async () => {
        const { calls, setContext } = makeRecorder();

        await refreshWelcomeState({
            setContext,
            hasAnyDocset: () => true,
            canResolve: () => false
        });

        expect(calls).toEqual([
            ['cppDocs.hasDocsets', true],
            ['cppDocs.canResolve', false]
        ]);
    });

    it('does NOT set cppDocs.canResolve when canResolve callback is omitted', async () => {
        const { calls, setContext } = makeRecorder();

        await refreshWelcomeState({
            setContext,
            hasAnyDocset: () => true
        });

        const keys = calls.map(([k]) => k);
        expect(keys).not.toContain('cppDocs.canResolve');
        expect(calls).toEqual([['cppDocs.hasDocsets', true]]);
    });

    it('awaits the setContext promise before returning', async () => {
        const order: string[] = [];
        const setContext = (_k: string, _v: boolean | string): Promise<void> =>
            new Promise<void>((resolve) => {
                setTimeout(() => {
                    order.push('setContext-resolved');
                    resolve();
                }, 10);
            });

        await refreshWelcomeState({
            setContext,
            hasAnyDocset: () => true
        });
        order.push('after-refresh');

        expect(order).toEqual(['setContext-resolved', 'after-refresh']);
    });
});
