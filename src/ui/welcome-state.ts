/**
 * Welcome / empty-state context-key driver.
 *
 * `viewsWelcome` `when` clauses can only see VSCode context keys, not workspace
 * state. This module owns the `cppDocs.hasDocsets` (already used) and
 * `cppDocs.canResolve` keys, calling `setContext` whenever something the keys
 * depend on changes (docset install/import/remove, resolver readiness).
 *
 * Pure-ish: `setContext` is the only injected side effect, which makes the
 * unit tests trivially recordable.
 */
export interface WelcomeStateDeps {
    setContext: (key: string, value: boolean | string) => Promise<void> | void;
    hasAnyDocset: () => boolean;
    /**
     * Returns true once the resolver chain is wired and at least one
     * strategy can produce a fully-qualified name. Optional — when
     * omitted, the `cppDocs.canResolve` key is left unset so `when` clauses
     * default to false.
     */
    canResolve?: () => boolean;
}

export async function refreshWelcomeState(deps: WelcomeStateDeps): Promise<void> {
    const hasDocsets = deps.hasAnyDocset();
    await deps.setContext('cppDocs.hasDocsets', hasDocsets);

    if (deps.canResolve) {
        const canResolve = deps.canResolve();
        await deps.setContext('cppDocs.canResolve', canResolve);
    }
}
