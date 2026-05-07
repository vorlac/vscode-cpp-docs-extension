import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
    compileCommandsCandidates,
    resolveCppStandard,
    type ResolvedStandard
} from './cpp-standard.js';

/**
 * Live-resolves the active C++ standard from VSCode config, the MS C/C++
 * extension's setting, and `compile_commands.json`. Re-resolves on:
 *   - `cppDocs.cppStandard` / `cppDocs.cppStandard.fallback` change
 *   - `C_Cpp.default.cppStandard` change (docs/06-gotchas.md O — easy to
 *     miss this one when filtering `onDidChangeConfiguration` events)
 *   - active editor change
 *   - any `compile_commands.json` write under the workspace
 *
 * Subscribers receive the new resolution; the surfaces post
 * `{type:'setStandard',value:'cxxNN'}` to webviews so filtering toggles
 * live without re-rendering (docs/02-architecture.md §"…resolution order"
 * final paragraph).
 */
export class CppStandardManager implements vscode.Disposable {
    private resolved: ResolvedStandard;
    private readonly emitter = new vscode.EventEmitter<ResolvedStandard>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.resolved = this.compute();
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration('cppDocs.cppStandard') ||
                    e.affectsConfiguration('cppDocs.cppStandard.fallback') ||
                    e.affectsConfiguration('C_Cpp.default.cppStandard')
                ) {
                    this.refresh();
                }
            }),
            vscode.window.onDidChangeActiveTextEditor(() => this.refresh())
        );
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                '**/compile_commands.json'
            );
            watcher.onDidChange(() => this.refresh());
            watcher.onDidCreate(() => this.refresh());
            watcher.onDidDelete(() => this.refresh());
            this.disposables.push(watcher);
        }
    }

    current(): ResolvedStandard {
        return this.resolved;
    }

    onChange(listener: (r: ResolvedStandard) => void): vscode.Disposable {
        return this.emitter.event(listener);
    }

    refresh(): void {
        const next = this.compute();
        if (
            next.token !== this.resolved.token ||
            next.source !== this.resolved.source
        ) {
            this.resolved = next;
            this.emitter.fire(next);
        }
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.emitter.dispose();
    }

    private compute(): ResolvedStandard {
        const cppDocs = vscode.workspace.getConfiguration('cppDocs');
        const cppDocsSetting = cppDocs.get<string>('cppStandard') ?? 'auto';
        const fallbackSetting =
            cppDocs.get<string>('cppStandard.fallback') ?? 'c++20';
        const msCppExt = vscode.workspace
            .getConfiguration('C_Cpp', null)
            .get<string>('default.cppStandard');

        const editor = vscode.window.activeTextEditor;
        const activeDocumentPath =
            editor && editor.document.uri.scheme === 'file'
                ? editor.document.uri.fsPath
                : undefined;

        let compileEntries: unknown | undefined;
        if (activeDocumentPath) {
            const folder = vscode.workspace.getWorkspaceFolder(
                vscode.Uri.file(activeDocumentPath)
            );
            const folderPath =
                folder?.uri.fsPath ??
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (folderPath) {
                for (const candidate of compileCommandsCandidates(folderPath)) {
                    try {
                        const content = fs.readFileSync(candidate, 'utf8');
                        const parsed = JSON.parse(content);
                        if (Array.isArray(parsed)) {
                            compileEntries = parsed;
                            break;
                        }
                    } catch {
                        // try next candidate
                    }
                }
            }
        }

        return resolveCppStandard({
            cppDocsSetting,
            fallbackSetting,
            ...(msCppExt !== undefined ? { msCppExtSetting: msCppExt } : {}),
            ...(compileEntries !== undefined ? { compileEntries } : {}),
            ...(activeDocumentPath !== undefined ? { activeDocumentPath } : {})
        });
    }
}
