import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm' with { 'resolution-mode': 'import' };

let _sqlite3: Sqlite3Static | undefined;

export async function getSqlite3(): Promise<Sqlite3Static> {
    if (_sqlite3) return _sqlite3;
    const mod = await import('@sqlite.org/sqlite-wasm');
    _sqlite3 = await mod.default();
    return _sqlite3;
}
