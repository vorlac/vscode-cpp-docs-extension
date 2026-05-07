import * as vscode from 'vscode';
import type { ClientToHostMessage } from './messages.js';
import { COMMAND_IDS } from '../constants.js';

export interface HostMessageHandlers {
    /** Called when the client posts `nav` for an in-docset URL. */
    onNav?: (href: string) => void | Promise<void>;
    /** Called when the client posts `setState` for scroll persistence. */
    onState?: (state: { scrollY: number }) => void;
    /** Called once when the client signals `ready` after bootstrap. */
    onReady?: () => void;
    /** Called when the client requests a zoom level change (delta = ±step). */
    onZoomDelta?: (delta: number) => void | Promise<void>;
    /** Called when the webview-side picker selects a new base16 code theme. */
    onPickCodeTheme?: (themeId: string) => void | Promise<void>;
    /** Diagnostic — fired for every click classification (skip/nav/external/anchor). */
    onClick?: (info: {
        decision: 'nav' | 'external' | 'anchor' | 'skip';
        rawHref: string;
        resolvedHref: string;
        docsetWebviewBase: string;
        hasExternalMarker: boolean;
        inInteractiveAncestor: boolean;
    }) => void;
}

/**
 * Wire host-side handling of webview-client messages. `openExternal` is
 * always handled by routing through `vscode.env.openExternal` — callers can
 * customize `nav`/`setState`/`ready` via handlers. Returns the disposable
 * for the message subscription so the caller can include it in
 * `context.subscriptions`.
 */
export function installHostMessageHandler(
    webview: vscode.Webview,
    handlers: HostMessageHandlers = {}
): vscode.Disposable {
    return webview.onDidReceiveMessage(async (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return;
        const msg = raw as ClientToHostMessage;
        switch (msg.type) {
            case 'openExternal':
                if (typeof msg.href === 'string') {
                    try {
                        await vscode.env.openExternal(vscode.Uri.parse(msg.href));
                    } catch {
                        // Malformed URI — ignore. The webview filters most cases already.
                    }
                }
                break;
            case 'nav':
                if (typeof msg.href === 'string') await handlers.onNav?.(msg.href);
                break;
            case 'setState':
                if (typeof msg.scrollY === 'number') {
                    handlers.onState?.({ scrollY: msg.scrollY });
                }
                break;
            case 'zoomDelta':
                if (typeof msg.delta === 'number') await handlers.onZoomDelta?.(msg.delta);
                break;
            case 'pickCodeTheme':
                if (typeof msg.themeId === 'string') {
                    await handlers.onPickCodeTheme?.(msg.themeId);
                }
                break;
            case 'ready':
                handlers.onReady?.();
                break;
            case 'runCommand':
                // Allowlisted commands only -- the type narrows `msg.command`
                // but we re-check at runtime because tampered messages could
                // carry a different string. The allowlist covers the four
                // user-affordance commands surfaced inside the webview chrome:
                // history navigation (back/forward) and surface relocation
                // (moveToEditorTab/dockInSidebar).
                if (
                    msg.command === COMMAND_IDS.back ||
                    msg.command === COMMAND_IDS.forward ||
                    msg.command === COMMAND_IDS.moveToEditorTab ||
                    msg.command === COMMAND_IDS.dockInSidebar
                ) {
                    try {
                        await vscode.commands.executeCommand(msg.command);
                    } catch {
                        // Commands no-op when there's no surface / no history;
                        // a thrown error here would mean a programmer mistake,
                        // not user input — swallow so the webview doesn't get
                        // wedged in case of a transient extension state issue.
                    }
                }
                break;
            case 'click':
                if (
                    (msg.decision === 'nav' ||
                        msg.decision === 'external' ||
                        msg.decision === 'anchor' ||
                        msg.decision === 'skip') &&
                    typeof msg.rawHref === 'string' &&
                    typeof msg.resolvedHref === 'string' &&
                    typeof msg.docsetWebviewBase === 'string'
                ) {
                    handlers.onClick?.({
                        decision: msg.decision,
                        rawHref: msg.rawHref,
                        resolvedHref: msg.resolvedHref,
                        docsetWebviewBase: msg.docsetWebviewBase,
                        hasExternalMarker: !!msg.hasExternalMarker,
                        inInteractiveAncestor: !!msg.inInteractiveAncestor
                    });
                }
                break;
        }
    });
}
