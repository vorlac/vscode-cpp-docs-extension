import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const RUNTIME_NATIVE_OR_DYNAMIC = [
    'vscode',
    // @sqlite.org/sqlite-wasm is ESM-only and loads its WASM blob from
    // disk relative to its own dist directory at runtime. Bundling it
    // would inline the WASM as a base64 string (~700KB bundle bloat)
    // and break the loader path lookup. External keeps the require()
    // path resolvable to node_modules at runtime, where the package
    // ships its WASM next to the JS entry point.
    '@sqlite.org/sqlite-wasm',
    'lzma-native',
    'tar',
    'node-stream-zip',
    'plist',
    'saxes'
];

const hostConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    external: RUNTIME_NATIVE_OR_DYNAMIC,
    format: 'cjs',
    outfile: 'dist/host/extension.js',
    sourcemap: true,
    logLevel: 'info'
};

const clientConfig = {
    entryPoints: ['src/webview-client/index.ts'],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    outfile: 'dist/client/bootstrap.js',
    sourcemap: true,
    minify: !watch,
    logLevel: 'info'
};

if (watch) {
    const hostCtx = await context(hostConfig);
    const clientCtx = await context(clientConfig);
    await Promise.all([hostCtx.watch(), clientCtx.watch()]);
    process.stdout.write('esbuild: watching host + client bundles\n');
} else {
    await Promise.all([build(hostConfig), build(clientConfig)]);
}
