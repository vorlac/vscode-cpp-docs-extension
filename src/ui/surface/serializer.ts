import * as vscode from 'vscode';
import {
    rehydratePanel,
    type PanelDeps
} from './webview-panel.js';

/**
 * Persisted shape for the webview-panel surface. The webview-client writes
 * this via `vscode.setState` on every nav/scroll, and VSCode hands it back
 * to `deserializeWebviewPanel` when reviving a panel after restart
 * (docs/02-architecture.md §"State persistence layers" tier 2).
 */
export interface SerializedPanelState {
    active?: { docsetId: number; pagePath: string; scrollY?: number };
}

export class DocPanelSerializer
    implements vscode.WebviewPanelSerializer<SerializedPanelState> {
    constructor(private readonly deps: PanelDeps) { }

    async deserializeWebviewPanel(
        panel: vscode.WebviewPanel,
        state: SerializedPanelState | undefined
    ): Promise<void> {
        await rehydratePanel(panel, state, this.deps);
    }
}
