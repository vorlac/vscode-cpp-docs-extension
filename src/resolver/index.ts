// Public re-export module for the C++ symbol resolver.
//
// The rest of the extension consumes the resolver via this barrel.
// Strategy sub-tasks (M4.1–M4.4) and the cache layer (M4.5) import
// types from `./types.js`; M4.6 wires the composer into `extension.ts`
// through `buildProductionResolver`.

export { buildProductionResolver, composeResolver } from './cpp.js';
export type {
    ComposeOptions,
    ResolverFactoryDeps,
    ResolverStrategyEntry
} from './cpp.js';
export type {
    Resolver,
    ResolveContext,
    ResolvedSymbol,
    ResolverStrategy,
    ResolverStrategyName
} from './types.js';
export { handleCursorChange } from './cursor-follow.js';
export type {
    CursorFollowDeps,
    CursorFollowSurfaces,
    OnMissBehavior
} from './cursor-follow.js';
