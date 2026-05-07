import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { IndexDB, type ContentHit } from './index.js';
import {
    type Fetcher,
    type InstallResult,
    installCppreference
} from './cppreference-installer.js';
import { indexTagXml } from './cppreference-indexer.js';
import type { DocsetRow, SymbolHit } from './types.js';

export type ProgressFn = (msg: string) => void;

/**
 * Diagnostic logger. Production wiring in `extension.ts` injects
 * `logEvent` from `src/util/output.ts`; tests omit it (defaults to
 * no-op) so we don't drag the `vscode` import chain into the test
 * runtime.
 */
export type DocsetLog = (
    event: string,
    fields?: Record<string, unknown>
) => void;

export interface ManagerOptions {
    storageDir: string;
    fetcher?: Fetcher;
    now?: () => number;
    /** Optional diagnostic logger; defaults to no-op. */
    log?: DocsetLog;
}

export interface CppreferenceInstallSummary {
    status: InstallResult['status'];
    version: string;
    inserted: number;
}

export class DocsetManager {
    private db: IndexDB | null = null;
    private readonly cppDir: string;
    private readonly log: DocsetLog;

    constructor(private readonly opts: ManagerOptions) {
        this.cppDir = path.join(opts.storageDir, 'cppreference');
        this.log = opts.log ?? ((): void => { });
    }

    async open(): Promise<void> {
        await mkdir(this.opts.storageDir, { recursive: true });
        this.db = await IndexDB.open(
            path.join(this.opts.storageDir, 'index.sqlite')
        );
    }

    close(): void {
        this.db?.close();
        this.db = null;
    }

    private requireDb(): IndexDB {
        if (!this.db) throw new Error('DocsetManager.open() not called');
        return this.db;
    }

    // T26: delegate to IndexDB.hasAnyDocset() (EXISTS query, no full scan)
    hasAnyDocset(): boolean {
        return this.requireDb().hasAnyDocset();
    }

    // T26: targeted primary-key lookup
    getDocsetById(id: number): DocsetRow | undefined {
        return this.requireDb().getDocsetById(id);
    }

    listDocsets(): DocsetRow[] {
        return this.requireDb().listDocsets();
    }

    async installCppreference(
        onProgress?: ProgressFn,
        version?: string
    ): Promise<CppreferenceInstallSummary> {
        this.requireDb();
        const fetcher = this.opts.fetcher;
        this.log('docset.install.start', {
            version: version ?? 'latest',
            source: 'cppreference'
        });
        const result = await installCppreference({
            storageDir: this.cppDir,
            ...(fetcher !== undefined ? { fetcher } : {}),
            ...(onProgress !== undefined ? { onProgress } : {}),
            ...(version !== undefined ? { version } : {})
        });

        // ALWAYS re-register and re-index, even when the on-disk files are
        // already current. The user-triggered "Install cppreference" command
        // is the natural escape hatch for picking up indexer / extension
        // updates without having to remove the docset first; short-
        // circuiting on `already-current` made every extension update
        // require a manual `Remove Docset…` to refresh the index. A few
        // seconds of re-indexing is a small cost for the consistency win.
        const summary = await this.registerAndIndex(result, onProgress);
        this.log('docset.install.complete', {
            version: summary.version,
            inserted: summary.inserted,
            status: summary.status
        });
        return summary;
    }

    private async registerAndIndex(
        result: InstallResult,
        onProgress?: ProgressFn
    ): Promise<CppreferenceInstallSummary> {
        const db = this.requireDb();
        // T30: use targeted SQL query instead of listDocsets().find(...)
        const existing = db.findDocsetBySource('cppreference');
        if (existing) db.removeDocset(existing.id);

        const docsetId = db.insertDocset({
            name: 'cppreference',
            source: 'cppreference',
            version: result.version,
            rootPath: result.rootPath,
            documentsDir: result.documentsDir,
            indexFormat: 'searchIndex',
            installedAt: Math.floor((this.opts.now ?? Date.now)() / 1000)
        });

        onProgress?.('Indexing cppreference symbols');
        const indexed = await indexTagXml(
            result.tagXmlPath,
            db,
            docsetId,
            result.documentsDir
        );
        return { status: result.status, version: result.version, inserted: indexed.inserted };
    }

    removeDocset(docsetId: number): void {
        const db = this.requireDb();
        // T30: use getDocsetById instead of listDocsets().find(...)
        const row = db.getDocsetById(docsetId);
        db.removeDocset(docsetId);
        this.log('docset.remove', { name: row?.name ?? `#${docsetId}` });
    }

    searchPrefix(prefix: string, limit: number) {
        return this.requireDb().searchPrefix(prefix, limit);
    }

    searchPrefixCI(prefix: string, limit: number) {
        return this.requireDb().searchPrefixCI(prefix, limit);
    }

    lookupExact(qualifiedName: string, docsetId?: number) {
        return this.requireDb().lookupExact(qualifiedName, docsetId);
    }

    /**
     * Smarter lookup used by cursor-follow / hover / QuickPick. See
     * `IndexDB.lookupBest`. Preferred over `lookupExact` when the input
     * may be a bare identifier (e.g. clangd resolved `using ::isdigit`
     * to the literal `isdigit`).
     */
    lookupBest(fqn: string, docsetId?: number) {
        return this.requireDb().lookupBest(fqn, docsetId);
    }

    // T36: passthrough for resolver fallback strategy
    lookupByUnqualified(name: string, parents: string[], docsetId?: number): SymbolHit[] {
        return this.requireDb().lookupByUnqualified(name, parents, docsetId);
    }

    // T36: passthrough for include-aware wrapper
    lookupHeader(qualifiedName: string): SymbolHit | undefined {
        return this.requireDb().lookupHeader(qualifiedName);
    }

    listKindsForDocset(docsetId: number, langFilter?: 'cpp' | 'c') {
        return this.requireDb().listKindsForDocset(docsetId, langFilter);
    }

    listSymbolsByKind(
        docsetId: number,
        kind: string,
        parentFilter: string | null | undefined,
        limit: number,
        langFilter?: 'cpp' | 'c'
    ) {
        return this.requireDb().listSymbolsByKind(
            docsetId,
            kind,
            parentFilter,
            limit,
            langFilter
        );
    }

    listParentsByKind(
        docsetId: number,
        kind: string,
        langFilter?: 'cpp' | 'c'
    ) {
        return this.requireDb().listParentsByKind(docsetId, kind, langFilter);
    }

    getSymbolById(symbolId: number) {
        return this.requireDb().getSymbolById(symbolId);
    }

    findSymbolByPath(docsetId: number, filePath: string) {
        return this.requireDb().findSymbolByPath(docsetId, filePath);
    }

    searchSymbolsForFilter(filter: string, limit: number) {
        return this.requireDb().searchSymbolsForFilter(filter, limit);
    }

    searchContent(query: string, limit: number): ContentHit[] {
        return this.requireDb().searchContent(query, limit);
    }

    // T27: call batch variant (no optimize per-batch)
    indexPageContent(docsetId: number, pages: { filePath: string; title: string; body: string }[]): void {
        this.requireDb().indexPageContentBatch(docsetId, pages);
    }

    // T27: run FTS optimize once after all batches
    finalizePageContent(): void {
        this.requireDb().finalizePageContent();
    }

}

export type { ContentHit };
