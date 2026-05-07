import * as fs from 'node:fs';
import * as path from 'node:path';
// The sqlite-wasm package is ESM-only; the host bundle is CJS. Type
// imports use the `with { resolution-mode: 'import' }` attribute so
// TypeScript resolves the ESM types under Node16 module resolution
// without complaining about a CJS-to-ESM static import. The runtime
// singleton is in ./sqlite-wasm.ts and uses a dynamic `import()` so
// the CJS host bundle can pull an ESM-only package at runtime.
import type {
    Database,
    SqlValue,
    Sqlite3Static
} from '@sqlite.org/sqlite-wasm' with { 'resolution-mode': 'import' };
import { applySchema } from './schema.js';
import { getSqlite3 } from './sqlite-wasm.js';
import type {
    DocsetInsert,
    DocsetRow,
    DocsetSource,
    IndexFormat,
    SymbolHit,
    SymbolInsert
} from './types.js';
import { stripAbiNamespaces } from '../util/fqn.js';
import { decodeHtmlEntities } from '../util/html-escape.js';

// ---------------------------------------------------------------------------
// SQLite WASM module — singleton lives in ./sqlite-wasm.ts.
// ---------------------------------------------------------------------------
//
// `getSqlite3()` loads the SQLite WASM blob (`sqlite3.wasm`) from the
// package's dist directory and resolves to a Sqlite3Static object that
// exposes the OO1 (object-oriented v1) sync DB API. The load is async
// + one-time per process; subsequent `IndexDB.open()` calls reuse the
// cached module instance.
//
// Why sqlite-wasm instead of native better-sqlite3:
//   - No native binding → no ABI to keep in sync between Node (tests)
//     and Electron (extension host). The same JS + WASM runs in both.
//   - No per-platform `.vsix` packaging — one bundle works on every
//     OS / CPU arch / VSCode version.
//   - Tradeoff is ~3–5× slower per query, but for our workload
//     (a single docs-lookup per cursor move, 250ms timeout budget)
//     the perf headroom is irrelevant.

// ---------------------------------------------------------------------------
// Raw row shapes returned by SQLite (snake_case column names) →
// camelCase TypeScript shapes the rest of the extension consumes.
// ---------------------------------------------------------------------------

interface RawDocsetRow {
    id: number;
    name: string;
    source: string;
    version: string | null;
    root_path: string;
    documents_dir: string;
    index_format: string;
    installed_at: number;
    is_active: number;
}

export interface ContentHit {
    docsetId: number;
    filePath: string;
    title: string;
}

interface RawHit {
    id: number;
    docset_id: number;
    docset_name: string;
    qualified_name: string;
    unqualified: string;
    parent: string | null;
    kind: string;
    file_path: string;
    anchor: string | null;
    arglist: string | null;
}

/**
 * Map a language filter (`cpp` / `c`) to the cppreference docset's
 * file_path prefix. Symbols under `en/cpp/...` belong to the C++
 * language tree, `en/c/...` to the C tree. We hard-code the prefix
 * (rather than parameterize) because cppreference's offline HTML book
 * has a fixed layout the indexer is built around.
 */
function langPathPrefix(lang: 'cpp' | 'c'): string {
    return lang === 'cpp' ? 'en/cpp/' : 'en/c/';
}

/**
 * Inverse of `langPathPrefix`: given a `file_path`, return which
 * language tree it belongs to, or `undefined` for unrecognized paths.
 */
export function detectLanguage(filePath: string): 'cpp' | 'c' | undefined {
    if (filePath.startsWith('en/cpp/')) return 'cpp';
    if (filePath.startsWith('en/c/')) return 'c';
    return undefined;
}

function toDocsetRow(r: RawDocsetRow): DocsetRow {
    return {
        id: r.id,
        name: r.name,
        source: r.source as DocsetSource,
        version: r.version,
        rootPath: r.root_path,
        documentsDir: r.documents_dir,
        indexFormat: r.index_format as IndexFormat,
        installedAt: r.installed_at,
        isActive: r.is_active === 1
    };
}

/**
 * Wrapper around `decodeHtmlEntities` that handles nullable values.
 * Decode the HTML entities that historically slipped through into symbol
 * columns from cppreference page titles (`std::atomic_ref&lt;T&gt;::store`,
 * `operator&amp;=`). The indexer decodes its inputs, but applying the same
 * pass on read protects tree/search labels against any leftover or future
 * data that wasn't re-indexed. Cheap and idempotent on already-clean text.
 */
function decodeSymbolField(s: string | null): string | null {
    if (s === null || s.indexOf('&') < 0) return s;
    return decodeHtmlEntities(s);
}

function toHit(r: RawHit): SymbolHit {
    return {
        id: r.id,
        docsetId: r.docset_id,
        docsetName: r.docset_name,
        qualifiedName: decodeSymbolField(r.qualified_name) ?? r.qualified_name,
        unqualified: decodeSymbolField(r.unqualified) ?? r.unqualified,
        parent: decodeSymbolField(r.parent),
        kind: r.kind,
        filePath: r.file_path,
        anchor: r.anchor,
        arglist: r.arglist
    };
}

// ---------------------------------------------------------------------------
// IndexDB wrapper around the sqlite-wasm OO1 Database. The public
// method surface is identical to the previous better-sqlite3-backed
// implementation; only `open()` changed from sync to async (the
// one-time WASM module load is async). All callers already invoke
// `open()` from an async path, so the async signature is a clean fit.
// ---------------------------------------------------------------------------

export class IndexDB {
    private constructor(
        private readonly db: Database,
        private readonly sqlite3: Sqlite3Static,
        /**
         * Disk path the DB was loaded from / should persist to. Undefined
         * for `:memory:` databases (tests) — those never flush.
         */
        private readonly persistPath: string | undefined
    ) { }

    /**
     * Open (or create) the index database at the given filesystem path.
     * Pass `':memory:'` for an in-memory DB (tests). The first call
     * lazily loads the WASM module; subsequent calls reuse the cached
     * module instance.
     *
     * sqlite-wasm's Node distribution doesn't expose a VFS that talks
     * to the host filesystem — paths like `/var/folders/...` resolve
     * inside the Emscripten MEMFS, not the real disk. We bridge that
     * by reading the file bytes via `node:fs` and deserializing them
     * into an in-memory SQLite database. Mutations are flushed back to
     * disk via `flush()` (called automatically by every mutation
     * method) using `sqlite3_js_db_export()` + an atomic temp-rename
     * write.
     */
    static async open(filePath: string): Promise<IndexDB> {
        const sqlite3 = await getSqlite3();
        // Always create the in-memory engine. `:memory:` is sqlite's
        // special filename for an anonymous in-memory DB; for our
        // persistent case we attach disk bytes via deserialize below.
        const db = new sqlite3.oo1.DB(':memory:', 'c');

        if (filePath !== ':memory:' && fs.existsSync(filePath)) {
            // Load existing bytes into the in-memory DB. We use the
            // FREEONCLOSE + RESIZEABLE flags so sqlite owns the buffer and
            // can grow it as future writes append pages.
            //
            // Cast the `node:fs` Buffer (subclass of Uint8Array) to a
            // plain Uint8Array view of the same backing storage —
            // sqlite-wasm's `allocFromTypedArray` introspects the element
            // size and rejects Buffer because its element-size lookup
            // path doesn't recognise the Buffer subclass.
            const buf = fs.readFileSync(filePath);
            const bytes = new Uint8Array(
                buf.buffer,
                buf.byteOffset,
                buf.byteLength
            );
            const p = sqlite3.wasm.allocFromTypedArray(bytes);
            const flags =
                sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
                sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
            const rc = sqlite3.capi.sqlite3_deserialize(
                db.pointer!,
                'main',
                p,
                bytes.length,
                bytes.length,
                flags
            );
            if (rc !== 0) {
                try {
                    db.close();
                } catch {
                    /* swallow */
                }
                throw new Error(
                    `sqlite3_deserialize failed (rc=${rc}) for ${filePath}`
                );
            }
        }

        db.exec('PRAGMA foreign_keys = ON;');
        applySchema(db);
        return new IndexDB(
            db,
            sqlite3,
            filePath === ':memory:' ? undefined : filePath
        );
    }

    close(): void {
        // Final flush so any pending mutations land on disk before we
        // tear the in-memory DB down. Errors here are surfaced (callers
        // can decide whether to retry / log); the in-memory close is
        // unconditional so we don't leak the WASM allocation.
        try {
            this.flush();
        } finally {
            this.db.close();
        }
    }

    /**
     * Serialize the in-memory database and atomically write it to disk
     * at `persistPath`. No-op for `:memory:` databases. Called
     * implicitly after every mutation method so callers don't have to
     * remember to flush — the cost (~10ms for a 3MB index file) is
     * acceptable because mutations are rare (install / import / remove
     * operations only).
     *
     * Atomic write: bytes go to a `.tmp` sibling first, then
     * `fs.renameSync` swaps it into place. A crash mid-write leaves
     * the old DB intact rather than a partial / corrupt file.
     */
    private flush(): void {
        if (this.persistPath === undefined) return;
        const bytes = this.sqlite3.capi.sqlite3_js_db_export(this.db.pointer!);
        const dir = path.dirname(this.persistPath);
        // Best-effort parent dir creation — the manager already ensures
        // the storage dir exists before calling open(), but a manual
        // user-driven removal between open and flush would crash here
        // otherwise.
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch {
            /* tolerate EEXIST etc.; writeFileSync below will surface real errors */
        }
        const tmp = this.persistPath + '.tmp';
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, this.persistPath);
    }

    insertDocset(d: DocsetInsert): number {
        this.db.exec({
            sql: `INSERT INTO docsets
              (name, source, version, root_path, documents_dir, index_format, installed_at, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            bind: [
                d.name,
                d.source,
                d.version,
                d.rootPath,
                d.documentsDir,
                d.indexFormat,
                d.installedAt,
                d.isActive === false ? 0 : 1
            ]
        });
        // sqlite-wasm OO1 doesn't expose `lastInsertRowid` as a property
        // (the better-sqlite3 API equivalent); query for it instead.
        // SQLite returns the value for the most recent INSERT on this
        // connection, which is the row we just wrote.
        const id = Number(this.db.selectValue('SELECT last_insert_rowid()'));
        this.flush();
        return id;
    }

    insertSymbols(docsetId: number, rows: SymbolInsert[]): void {
        // Prepare once, bind+step+reset per row inside one transaction.
        // This is the high-volume path during cppreference install
        // (~50k rows); preparing once vs per-row roughly halves index
        // time on cold install.
        const stmt = this.db.prepare(
            `INSERT INTO symbols
         (docset_id, qualified_name, unqualified, parent, kind, file_path, anchor, arglist)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        try {
            this.db.transaction(() => {
                for (const r of rows) {
                    stmt
                        .bind([
                            docsetId,
                            r.qualifiedName,
                            r.unqualified,
                            r.parent,
                            r.kind,
                            r.filePath,
                            r.anchor,
                            r.arglist
                        ])
                        .stepReset();
                }
            });
        } finally {
            stmt.finalize();
        }
        // One flush for the entire batch — serializing 50k+ row inserts
        // after each individual row would dominate install time.
        this.flush();
    }

    /**
     * Insert a batch of pages into the FTS index without running optimize.
     * Call `finalizePageContent()` once after all batches are done.
     */
    indexPageContentBatch(docsetId: number, pages: { filePath: string; title: string; body: string }[]): void {
        if (pages.length === 0) return;
        const stmt = this.db.prepare(
            `INSERT INTO fts_pages (docset_id, file_path, title, body) VALUES (?, ?, ?, ?)`
        );
        try {
            this.db.transaction(() => {
                for (const p of pages) {
                    stmt.bind([docsetId, p.filePath, p.title, p.body]).stepReset();
                }
            });
        } finally {
            stmt.finalize();
        }
        this.flush();
    }

    /**
     * Run FTS5 optimize once after all batches have been inserted, then
     * flush. Call this exactly once after the final `indexPageContentBatch`.
     */
    finalizePageContent(): void {
        this.db.exec(`INSERT INTO fts_pages(fts_pages) VALUES('optimize')`);
        this.flush();
    }

    /**
     * Insert pages into the FTS index and optimize in one shot. Retained for
     * callers that supply all pages at once (e.g. tests).
     */
    indexPageContent(docsetId: number, pages: { filePath: string; title: string; body: string }[]): void {
        this.indexPageContentBatch(docsetId, pages);
        this.finalizePageContent();
    }

    searchContent(query: string, limit: number): ContentHit[] {
        const sanitized = query.replace(/["*()^\\]/g, ' ').trim();
        if (!sanitized) return [];
        try {
            const rows = this.db.selectObjects(
                `SELECT docset_id, file_path, title FROM fts_pages WHERE fts_pages MATCH ? ORDER BY rank LIMIT ?`,
                [sanitized, limit]
            ) as unknown as { docset_id: number; file_path: string; title: string }[];
            return rows.map((r) => ({
                docsetId: r.docset_id,
                filePath: r.file_path,
                title: r.title
            }));
        } catch {
            return [];
        }
    }

    clearPageContent(docsetId: number): void {
        this.db.exec({
            sql: `DELETE FROM fts_pages WHERE docset_id = ?`,
            bind: [docsetId]
        });
    }

    removeDocset(id: number): void {
        this.db.transaction(() => {
            this.clearPageContent(id);
            this.db.exec({ sql: `DELETE FROM docsets WHERE id = ?`, bind: [id] });
        });
        this.flush();
    }

    listDocsets(): DocsetRow[] {
        const rows = this.db.selectObjects(
            `SELECT * FROM docsets ORDER BY installed_at, id`
        ) as unknown as RawDocsetRow[];
        return rows.map(toDocsetRow);
    }

    /** Returns true if at least one docset row exists. Uses EXISTS to avoid a full scan. */
    hasAnyDocset(): boolean {
        const v = this.db.selectValue(`SELECT EXISTS(SELECT 1 FROM docsets LIMIT 1)`);
        return Number(v) === 1;
    }

    /** Look up a docset by its primary key. Returns undefined if not found. */
    getDocsetById(id: number): DocsetRow | undefined {
        const r = this.db.selectObject(
            `SELECT * FROM docsets WHERE id = ? LIMIT 1`, [id]
        ) as unknown as RawDocsetRow | undefined;
        return r ? toDocsetRow(r) : undefined;
    }

    /** Find a docset by its source identifier (e.g. `'cppreference'`). */
    findDocsetBySource(source: string): DocsetRow | undefined {
        const r = this.db.selectObject(
            `SELECT * FROM docsets WHERE source = ? LIMIT 1`, [source]
        ) as unknown as RawDocsetRow | undefined;
        return r ? toDocsetRow(r) : undefined;
    }

    /** Find a docset by its root_path on disk. */
    findDocsetByPath(rootPath: string): DocsetRow | undefined {
        const r = this.db.selectObject(
            `SELECT * FROM docsets WHERE root_path = ? LIMIT 1`, [rootPath]
        ) as unknown as RawDocsetRow | undefined;
        return r ? toDocsetRow(r) : undefined;
    }

    lookupExact(qualifiedName: string, docsetId?: number): SymbolHit | undefined {
        if (docsetId === undefined) {
            const row = this.db.selectObject(
                `SELECT s.*, d.name AS docset_name
         FROM symbols s JOIN docsets d ON d.id = s.docset_id
         WHERE s.qualified_name = ? AND d.is_active = 1
         ORDER BY length(s.qualified_name)
         LIMIT 1`,
                [qualifiedName]
            ) as unknown as RawHit | undefined;
            return row ? toHit(row) : undefined;
        }
        const row = this.db.selectObject(
            `SELECT s.*, d.name AS docset_name
       FROM symbols s JOIN docsets d ON d.id = s.docset_id
       WHERE s.qualified_name = ? AND s.docset_id = ?
       LIMIT 1`,
            [qualifiedName, docsetId]
        ) as unknown as RawHit | undefined;
        return row ? toHit(row) : undefined;
    }

    /**
     * Find rows matching `unqualified = name`. When `parents` is non-empty,
     * the lookup is restricted to rows whose `parent` is one of the listed
     * scopes (or NULL); results are ranked by `parents` array order, then
     * NULL, then by shortest qualified name.
     *
     * Per the M-4 fix from the 2026-05-07 review: when `parents` is empty
     * we no longer restrict to top-level rows only — that variant was
     * silently dropping every C/C++ stdlib symbol whose only indexed form
     * lives under `std` (e.g. `isdigit` searched from a file with no
     * enclosing namespace and no `using namespace std;`). Empty `parents`
     * now matches any row, ranked top-level first, then `std`, then by
     * parent name length.
     */
    lookupByUnqualified(name: string, parents: string[], docsetId?: number): SymbolHit[] {
        const hasParents = parents.length > 0;
        const parentClause = hasParents
            ? ` AND (s.parent IN (${parents.map(() => '?').join(', ')}) OR s.parent IS NULL)`
            : '';
        const docsetClause =
            docsetId !== undefined ? ` AND s.docset_id = ?` : ` AND d.is_active = 1`;
        const sql = `
      SELECT s.*, d.name AS docset_name
      FROM symbols s JOIN docsets d ON d.id = s.docset_id
      WHERE s.unqualified = ?${parentClause}${docsetClause}
    `;
        const args: SqlValue[] = [name, ...(hasParents ? parents : [])];
        if (docsetId !== undefined) args.push(docsetId);
        const rows = this.db.selectObjects(sql, args) as unknown as RawHit[];

        const rank = (p: string | null): number => {
            if (hasParents) {
                if (p === null) return parents.length;
                const i = parents.indexOf(p);
                return i === -1 ? parents.length + 1 : i;
            }
            // No enclosing-scope info from the caller. Prefer top-level
            // (parent IS NULL), then `std` (the overwhelming common case for
            // any unqualified stdlib lookup), then everything else by parent
            // length (shorter parents are more general).
            if (p === null) return 0;
            if (p === 'std') return 1;
            return 2 + p.length;
        };

        return rows
            .map(toHit)
            .sort(
                (a, b) =>
                    rank(a.parent) - rank(b.parent) ||
                    a.qualifiedName.length - b.qualifiedName.length
            );
    }

    /**
     * Smart exact lookup: `lookupExact(fqn)` first, then a stripped-`::`
     * retry, then — for bare names — `lookupByUnqualified` ranked by the
     * "no scope info" heuristic above. Used by cursor-follow / hover /
     * QuickPick so a clangd-derived bare FQN like `isdigit` resolves to
     * the C `isdigit` page (top-level), and a `using ::isdigit` cursor
     * that produces `::isdigit` strips the leading `::` and lands on the
     * same C top-level row.
     *
     * `lookupExact` semantics are preserved for callers that still want
     * the strict variant — this method is additive.
     */
    lookupBest(fqn: string, docsetId?: number): SymbolHit | undefined {
        fqn = stripAbiNamespaces(fqn);
        const exact = this.lookupExact(fqn, docsetId);
        if (exact) return exact;
        if (fqn.startsWith('::')) {
            const stripped = fqn.slice(2);
            const exactStripped = this.lookupExact(stripped, docsetId);
            if (exactStripped) return exactStripped;
            if (!stripped.includes('::')) {
                const ranked = this.lookupByUnqualified(stripped, [], docsetId);
                if (ranked[0]) return ranked[0];
            }
            return undefined;
        }
        if (fqn.includes('::')) return undefined;
        const ranked = this.lookupByUnqualified(fqn, [], docsetId);
        return ranked[0];
    }

    /**
     * Distinct `kind` values for the given docset, with row counts. Used by the
     * tree provider to enumerate top-level categories.
     */
    listKindsForDocset(
        docsetId: number,
        langFilter?: 'cpp' | 'c'
    ): { kind: string; count: number }[] {
        const langClause = langFilter ? ` AND file_path LIKE ? ESCAPE '\\'` : '';
        const rows = this.db.selectObjects(
            `SELECT kind, COUNT(*) AS count
         FROM symbols
        WHERE docset_id = ?${langClause}
        GROUP BY kind
        ORDER BY kind`,
            langFilter ? [docsetId, langPathPrefix(langFilter) + '%'] : [docsetId]
        ) as unknown as { kind: string; count: number }[];
        return rows.map((r) => ({ kind: r.kind, count: Number(r.count) }));
    }

    /**
     * Symbols in a single (docset_id, kind) bucket. `parentFilter` semantics:
     *  - `undefined` → no parent restriction (all rows in the bucket)
     *  - `null`      → only rows with `parent IS NULL`
     *  - string      → only rows with `parent = parentFilter`
     * Ordered alphabetically by qualified_name; capped by `limit`.
     */
    listSymbolsByKind(
        docsetId: number,
        kind: string,
        parentFilter: string | null | undefined,
        limit: number,
        langFilter?: 'cpp' | 'c'
    ): SymbolHit[] {
        let parentClause = '';
        const args: SqlValue[] = [docsetId, kind];
        if (parentFilter === null) {
            parentClause = ` AND s.parent IS NULL`;
        } else if (parentFilter !== undefined) {
            parentClause = ` AND s.parent = ?`;
            args.push(parentFilter);
        }
        const langClause = langFilter ? ` AND s.file_path LIKE ? ESCAPE '\\'` : '';
        if (langFilter) args.push(langPathPrefix(langFilter) + '%');
        args.push(limit);
        const rows = this.db.selectObjects(
            `SELECT s.*, d.name AS docset_name
         FROM symbols s JOIN docsets d ON d.id = s.docset_id
        WHERE s.docset_id = ? AND s.kind = ?${parentClause}${langClause}
        ORDER BY s.qualified_name ASC
        LIMIT ?`,
            args
        ) as unknown as RawHit[];
        return rows.map(toHit);
    }

    /**
     * Distinct parents within a (docset_id, kind) bucket, with row counts.
     * Used by the tree provider to sub-group very large categories.
     */
    listParentsByKind(
        docsetId: number,
        kind: string,
        langFilter?: 'cpp' | 'c'
    ): { parent: string | null; count: number }[] {
        const langClause = langFilter ? ` AND file_path LIKE ? ESCAPE '\\'` : '';
        const rows = this.db.selectObjects(
            `SELECT parent, COUNT(*) AS count
         FROM symbols
        WHERE docset_id = ? AND kind = ?${langClause}
        GROUP BY parent
        ORDER BY (parent IS NULL) ASC, parent ASC`,
            langFilter ? [docsetId, kind, langPathPrefix(langFilter) + '%'] : [docsetId, kind]
        ) as unknown as { parent: string | null; count: number }[];
        return rows.map((r) => ({
            parent: decodeSymbolField(r.parent),
            count: Number(r.count)
        }));
    }

    /**
     * Find the first `Header`-kind row whose `qualified_name` matches
     * `qualifiedName` exactly. Used by `wrapWithIncludeAwareness` to
     * resolve `#include <X>` directives: because multiple rows can share
     * the same name with different kinds (e.g. `array` exists as both a
     * `Language` row for the C++ array-type page AND a `Header` row for
     * `<array>`), a plain `lookupExact` returns an arbitrary kind when
     * the `ORDER BY length` tiebreaker is ambiguous. This query pins
     * `kind = 'Header'` so the correct page is always returned.
     */
    lookupHeader(qualifiedName: string): SymbolHit | undefined {
        const row = this.db.selectObject(
            `SELECT s.*, d.name AS docset_name
         FROM symbols s JOIN docsets d ON d.id = s.docset_id
         WHERE s.qualified_name = ? AND s.kind = 'Header' AND d.is_active = 1
         LIMIT 1`,
            [qualifiedName]
        ) as unknown as RawHit | undefined;
        return row ? toHit(row) : undefined;
    }

    /** Look up a symbol by its primary key. Used by the tree provider's getParent. */
    getSymbolById(symbolId: number): SymbolHit | undefined {
        const row = this.db.selectObject(
            `SELECT s.*, d.name AS docset_name
         FROM symbols s JOIN docsets d ON d.id = s.docset_id
        WHERE s.id = ?
        LIMIT 1`,
            [symbolId]
        ) as unknown as RawHit | undefined;
        return row ? toHit(row) : undefined;
    }

    /**
     * Look up the canonical symbol for a (docset_id, file_path) pair. Used by the
     * tree-reveal hook: after a navigation lands the webview on a page, we need
     * to walk back to the matching `symbols` row to construct the DocNode for
     * `treeView.reveal()`. cppreference is one-page-per-symbol so a single match
     * is the norm; where multiple symbols share a `file_path` (e.g. an owner
     * symbol and a member), prefer the row with the shortest `qualified_name`
     * (the canonical symbol — class-template name over an instantiation).
     */
    findSymbolByPath(docsetId: number, filePath: string): SymbolHit | undefined {
        const row = this.db.selectObject(
            `SELECT s.*, d.name AS docset_name
         FROM symbols s JOIN docsets d ON d.id = s.docset_id
        WHERE s.docset_id = ? AND s.file_path = ?
        ORDER BY length(s.qualified_name) ASC, s.id ASC
        LIMIT 1`,
            [docsetId, filePath]
        ) as unknown as RawHit | undefined;
        return row ? toHit(row) : undefined;
    }

    /**
     * Substring-match symbols by `qualified_name` (case-insensitive). Used by the
     * tree-provider filter input to narrow the visible tree without scanning the
     * whole index from the JS side. Returns one row per matching symbol with the
     * minimum identity needed to derive the visible-ancestors set
     * (`docset_id`, `kind`, `parent`, `qualified_name`).
     *
     * `%` and `_` in the input are treated as literal characters (escaped via
     * `ESCAPE '\'`) so a user typing `op_` doesn't expand to a wildcard. The
     * filter is also bound parameterized to prevent SQL injection.
     *
     * `limit` caps the row count so a 1-character filter on a 50k-symbol index
     * doesn't materialize every row. The caller treats truncation transparently
     * (visible set is still a superset of any deeper match — but the user
     * obviously needs to type more to narrow it further).
     */
    searchSymbolsForFilter(
        filter: string,
        limit: number
    ): {
        symbolId: number;
        docsetId: number;
        kind: string;
        parent: string | null;
        qualifiedName: string;
        filePath: string;
    }[] {
        const escaped = filter.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const needle = `%${escaped}%`;
        const rows = this.db.selectObjects(
            `SELECT s.id          AS id,
              s.docset_id   AS docset_id,
              s.kind        AS kind,
              s.parent      AS parent,
              s.qualified_name AS qualified_name,
              s.file_path   AS file_path
         FROM symbols s
         JOIN docsets d ON d.id = s.docset_id
        WHERE d.is_active = 1
          AND s.qualified_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY s.docset_id, s.kind, s.parent, s.qualified_name
        LIMIT ?`,
            [needle, limit]
        ) as unknown as {
            id: number;
            docset_id: number;
            kind: string;
            parent: string | null;
            qualified_name: string;
            file_path: string;
        }[];
        return rows.map((r) => ({
            symbolId: r.id,
            docsetId: r.docset_id,
            kind: r.kind,
            parent: r.parent,
            qualifiedName: r.qualified_name,
            filePath: r.file_path
        }));
    }

    searchPrefix(prefix: string, limit: number): SymbolHit[] {
        // Range comparison drives a BTREE SEARCH on `qualified_name`'s default
        // BINARY collation — ~10× faster than LIKE 'prefix%' (which falls back
        // to a SCAN under SQLite's case-insensitive LIKE default). The upper
        // bound is the prefix with a high sentinel appended so any string
        // starting with the prefix sorts strictly less than the bound.
        //
        // L-4 — `\u{10FFFF}` (max Unicode codepoint) is strictly greater
        // than any valid identifier under SQLite's BINARY collation (UTF-8
        // byte sequence comparison) so any string beginning with `prefix`
        // sorts below the bound, including astral-plane characters.
        const upper = prefix + '\u{10FFFF}';
        const rows = this.db.selectObjects(
            `SELECT s.*, d.name AS docset_name
       FROM symbols s JOIN docsets d ON d.id = s.docset_id
       WHERE s.qualified_name >= ? AND s.qualified_name < ?
         AND d.is_active = 1
       ORDER BY length(s.qualified_name), s.qualified_name
       LIMIT ?`,
            [prefix, upper, limit]
        ) as unknown as RawHit[];
        return rows.map(toHit);
    }

    /**
     * M-6 — case-insensitive companion to `searchPrefix`. Performs the
     * same BINARY-collated range scan with the lowercased prefix, then
     * unions the result with `searchPrefix(prefix)` so callers that
     * pass a mixed-case prefix get both shapes (`std::vec` matches
     * `std::vector`; `STD::Vec` also does). De-duplicated by symbol id;
     * ranked the same way (shortest qualified name first).
     */
    searchPrefixCI(prefix: string, limit: number): SymbolHit[] {
        const seen = new Set<number>();
        const out: SymbolHit[] = [];
        const append = (hit: SymbolHit): void => {
            if (seen.has(hit.id)) return;
            seen.add(hit.id);
            out.push(hit);
        };
        for (const h of this.searchPrefix(prefix, limit)) append(h);
        const lower = prefix.toLowerCase();
        if (lower !== prefix && out.length < limit) {
            for (const h of this.searchPrefix(lower, limit)) append(h);
        }
        out.sort(
            (a, b) =>
                a.qualifiedName.length - b.qualifiedName.length ||
                a.qualifiedName.localeCompare(b.qualifiedName)
        );
        return out.slice(0, limit);
    }
}

export type { DocsetInsert, DocsetRow, SymbolHit, SymbolInsert } from './types.js';
