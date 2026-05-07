declare module 'lzma-native' {
    import { Transform } from 'node:stream';
    export interface LzmaOptions {
        preset?: number;
        check?: number;
        memlimit?: number;
    }
    export function createCompressor(opts?: LzmaOptions): Transform;
    export function createDecompressor(opts?: LzmaOptions): Transform;
    export const PRESET_DEFAULT: number;
}
