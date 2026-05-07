import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternalMock, executeCommandMock } = vi.hoisted(() => ({
    openExternalMock: vi.fn<(uri: unknown) => Promise<boolean>>(async () => true),
    executeCommandMock: vi.fn<(command: string, ...rest: unknown[]) => Promise<unknown>>(
        async () => undefined
    )
}));

vi.mock('vscode', () => ({
    Uri: {
        parse: (s: string) => ({ toString: () => s, _parsed: s })
    },
    env: {
        openExternal: openExternalMock
    },
    commands: {
        executeCommand: executeCommandMock
    }
}));

import { installHostMessageHandler } from '../../src/webview-host/host-messages.js';

interface CapturedHandler {
    invoke: (msg: unknown) => Promise<void>;
}

function makeWebview(): {
    webview: {
        onDidReceiveMessage: (
            cb: (msg: unknown) => void
        ) => { dispose: () => void };
    };
    captured: CapturedHandler;
} {
    const captured: CapturedHandler = {
        invoke: async () => {
            throw new Error('handler not registered');
        }
    };
    return {
        webview: {
            onDidReceiveMessage: (cb) => {
                captured.invoke = async (msg: unknown) => {
                    await cb(msg);
                };
                return { dispose: () => { } };
            }
        },
        captured
    };
}

describe('installHostMessageHandler', () => {
    beforeEach(() => {
        openExternalMock.mockClear();
        executeCommandMock.mockClear();
        executeCommandMock.mockResolvedValue(undefined);
    });

    it('routes openExternal messages through vscode.env.openExternal', async () => {
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never);
        await captured.invoke({
            type: 'openExternal',
            href: 'https://example.com'
        });
        expect(openExternalMock).toHaveBeenCalledOnce();
        const calls = openExternalMock.mock.calls as unknown as Array<
            [{ _parsed: string }]
        >;
        expect(calls[0]?.[0]?._parsed).toBe('https://example.com');
    });

    it('swallows malformed openExternal URIs without throwing', async () => {
        openExternalMock.mockRejectedValueOnce(new Error('bad uri'));
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never);
        await expect(
            captured.invoke({ type: 'openExternal', href: 'https://example.com' })
        ).resolves.toBeUndefined();
    });

    it('invokes onNav for nav messages', async () => {
        const onNav = vi.fn();
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never, { onNav });
        await captured.invoke({
            type: 'nav',
            href: 'webview-cdn://docset/cpp/algorithm/sort.html'
        });
        expect(onNav).toHaveBeenCalledWith(
            'webview-cdn://docset/cpp/algorithm/sort.html'
        );
        expect(openExternalMock).not.toHaveBeenCalled();
    });

    it('invokes onState for setState messages with valid payload', async () => {
        const onState = vi.fn();
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never, { onState });
        await captured.invoke({ type: 'setState', scrollY: 200 });
        expect(onState).toHaveBeenCalledWith({ scrollY: 200 });
    });

    it('rejects malformed setState payloads silently', async () => {
        const onState = vi.fn();
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never, { onState });
        await captured.invoke({ type: 'setState', scrollY: 'nope' });
        await captured.invoke({ type: 'setState' });
        expect(onState).not.toHaveBeenCalled();
    });

    it('invokes onReady for ready messages', async () => {
        const onReady = vi.fn();
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never, { onReady });
        await captured.invoke({ type: 'ready' });
        expect(onReady).toHaveBeenCalledOnce();
    });

    it('forwards click diagnostic messages with all decision branches', async () => {
        const onClick = vi.fn();
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never, { onClick });
        await captured.invoke({
            type: 'click',
            decision: 'nav',
            rawHref: '../../algorithm.html',
            resolvedHref: 'https://x/docset/cppreference/v/reference/en/cpp/algorithm.html',
            docsetWebviewBase: 'https://x/docset/cppreference/v/reference/',
            hasExternalMarker: false,
            inInteractiveAncestor: false
        });
        expect(onClick).toHaveBeenCalledOnce();
        const arg = onClick.mock.calls[0]?.[0];
        expect(arg?.decision).toBe('nav');
        expect(arg?.resolvedHref).toContain('algorithm.html');
    });

    it('rejects malformed click payloads silently', async () => {
        const onClick = vi.fn();
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never, { onClick });
        await captured.invoke({ type: 'click', decision: 'unknown', rawHref: '', resolvedHref: '', docsetWebviewBase: '' });
        await captured.invoke({ type: 'click', decision: 'nav' });
        expect(onClick).not.toHaveBeenCalled();
    });

    it('dispatches runCommand for the allowlisted back command', async () => {
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never);
        await captured.invoke({ type: 'runCommand', command: 'cppDocs.back' });
        expect(executeCommandMock).toHaveBeenCalledOnce();
        expect(executeCommandMock.mock.calls[0]?.[0]).toBe('cppDocs.back');
    });

    it('dispatches runCommand for the allowlisted forward command', async () => {
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never);
        await captured.invoke({ type: 'runCommand', command: 'cppDocs.forward' });
        expect(executeCommandMock).toHaveBeenCalledOnce();
        expect(executeCommandMock.mock.calls[0]?.[0]).toBe('cppDocs.forward');
    });

    it('ignores runCommand payloads carrying a non-allowlisted command id', async () => {
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never);
        await captured.invoke({
            type: 'runCommand',
            command: 'workbench.action.closeWindow'
        });
        await captured.invoke({ type: 'runCommand', command: 'cppDocs.openSymbol' });
        expect(executeCommandMock).not.toHaveBeenCalled();
    });

    it('swallows command-execution errors so the webview is not wedged', async () => {
        executeCommandMock.mockRejectedValueOnce(new Error('boom'));
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never);
        await expect(
            captured.invoke({ type: 'runCommand', command: 'cppDocs.back' })
        ).resolves.toBeUndefined();
    });

    it('ignores non-object messages and unknown types', async () => {
        const onNav = vi.fn();
        const onState = vi.fn();
        const onReady = vi.fn();
        const { webview, captured } = makeWebview();
        installHostMessageHandler(webview as never, { onNav, onState, onReady });
        await captured.invoke(null);
        await captured.invoke('string');
        await captured.invoke(42);
        await captured.invoke({ type: 'unknown' });
        expect(openExternalMock).not.toHaveBeenCalled();
        expect(onNav).not.toHaveBeenCalled();
        expect(onState).not.toHaveBeenCalled();
        expect(onReady).not.toHaveBeenCalled();
    });
});
