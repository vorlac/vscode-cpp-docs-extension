export type IndexFormat = 'searchIndex';
export type DocsetSource = 'cppreference' | 'external';

export interface DocsetInsert {
    name: string;
    source: DocsetSource;
    version: string | null;
    rootPath: string;
    documentsDir: string;
    indexFormat: IndexFormat;
    installedAt: number;
    isActive?: boolean;
}

export interface DocsetRow {
    id: number;
    name: string;
    source: DocsetSource;
    version: string | null;
    rootPath: string;
    documentsDir: string;
    indexFormat: IndexFormat;
    installedAt: number;
    isActive: boolean;
}

export interface SymbolInsert {
    qualifiedName: string;
    unqualified: string;
    parent: string | null;
    kind: string;
    filePath: string;
    anchor: string | null;
    arglist: string | null;
}

export interface SymbolHit extends SymbolInsert {
    id: number;
    docsetId: number;
    docsetName: string;
}
