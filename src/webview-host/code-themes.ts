/**
 * Base16-driven code-snippet color schemes for the C++ Docs webview.
 *
 * The webview re-tokenizes cppreference code blocks via highlight.js
 * (`webview-client/syntax.ts`); template.ts maps the resulting hljs
 * classes to a small set of CSS variables (--cppref-hljs-*). Each
 * entry here provides values for those variables, plus the block's
 * background / foreground / selection chrome. Switching themes is a
 * pure CSS-variable swap — no re-render, no re-tokenization.
 *
 * Slot semantics follow the standard base16 specification
 * (https://github.com/chriskempson/base16/blob/main/styling.md):
 *
 *   base00 — Default Background
 *   base01 — Lighter Background (status bars, gutters)
 *   base02 — Selection Background
 *   base03 — Comments / Invisibles / Line Highlight
 *   base04 — Dark Foreground (status bars)
 *   base05 — Default Foreground / Delimiters / Operators
 *   base06 — Light Foreground
 *   base07 — Light Background
 *   base08 — Variables / Diff Deleted (red)
 *   base09 — Integers / Booleans / Constants (orange)
 *   base0A — Classes / Markup Bold (yellow)
 *   base0B — Strings / Markup Code / Diff Inserted (green)
 *   base0C — Support / Regex / Escape Chars (cyan)
 *   base0D — Functions / Methods / Headings (blue)
 *   base0E — Keywords / Storage / Markup Italic (magenta)
 *   base0F — Deprecated / Embedded Tags (brown)
 *
 * The hljs class-to-slot mapping mirrors the canonical
 * `highlight.js/styles/base16/*.css` family (e.g. tomorrow-night,
 * default-dark, dracula) so behavior matches what users expect from
 * other tools that ship base16 themes.
 */

export interface Base16Palette {
    base00: string; base01: string; base02: string; base03: string;
    base04: string; base05: string; base06: string; base07: string;
    base08: string; base09: string; base0A: string; base0B: string;
    base0C: string; base0D: string; base0E: string; base0F: string;
}

export interface CodeTheme {
    /** Stable identifier used in settings (`cppDocs.codeTheme`). */
    id: string;
    /** Human-readable label shown in the picker. */
    label: string;
    /** Drives the picker grouping and any kind-dependent selection contrast. */
    kind: 'dark' | 'light';
    palette: Base16Palette;
}

/* ------------------------------------------------------------------------- *
 * Dark schemes (15)
 * ------------------------------------------------------------------------- */

const TOMORROW_NIGHT: Base16Palette = {
    base00: '#1d1f21', base01: '#282a2e', base02: '#373b41', base03: '#969896',
    base04: '#b4b7b4', base05: '#c5c8c6', base06: '#e0e0e0', base07: '#ffffff',
    base08: '#cc6666', base09: '#de935f', base0A: '#f0c674', base0B: '#b5bd68',
    base0C: '#8abeb7', base0D: '#81a2be', base0E: '#b294bb', base0F: '#a3685a'
};

// Hybrid (Tomorrow Night Bright derivative) — preserves the prior default look.
const HYBRID: Base16Palette = {
    base00: '#1d1f21', base01: '#282a2e', base02: '#373b41', base03: '#707880',
    base04: '#b4b7b4', base05: '#c5c8c6', base06: '#e0e0e0', base07: '#ffffff',
    base08: '#cc6666', base09: '#de935f', base0A: '#f0c674', base0B: '#b5bd68',
    base0C: '#8abeb7', base0D: '#81a2be', base0E: '#b294bb', base0F: '#a3685a'
};

const TOMORROW_NIGHT_EIGHTIES: Base16Palette = {
    base00: '#2d2d2d', base01: '#393939', base02: '#515151', base03: '#999999',
    base04: '#b4b7b4', base05: '#cccccc', base06: '#e0e0e0', base07: '#ffffff',
    base08: '#f2777a', base09: '#f99157', base0A: '#ffcc66', base0B: '#99cc99',
    base0C: '#66cccc', base0D: '#6699cc', base0E: '#cc99cc', base0F: '#d27b53'
};

const DEFAULT_DARK: Base16Palette = {
    base00: '#181818', base01: '#282828', base02: '#383838', base03: '#585858',
    base04: '#b8b8b8', base05: '#d8d8d8', base06: '#e8e8e8', base07: '#f8f8f8',
    base08: '#ab4642', base09: '#dc9656', base0A: '#f7ca88', base0B: '#a1b56c',
    base0C: '#86c1b9', base0D: '#7cafc2', base0E: '#ba8baf', base0F: '#a16946'
};

const DRACULA: Base16Palette = {
    base00: '#282936', base01: '#3a3c4e', base02: '#4d4f68', base03: '#626483',
    base04: '#62d6e8', base05: '#e9e9f4', base06: '#f1f2f8', base07: '#f7f7fb',
    base08: '#ea51b2', base09: '#b45bcf', base0A: '#00f769', base0B: '#ebff87',
    base0C: '#a1efe4', base0D: '#62d6e8', base0E: '#b45bcf', base0F: '#00f769'
};

const NORD: Base16Palette = {
    base00: '#2e3440', base01: '#3b4252', base02: '#434c5e', base03: '#4c566a',
    base04: '#d8dee9', base05: '#e5e9f0', base06: '#eceff4', base07: '#8fbcbb',
    base08: '#bf616a', base09: '#d08770', base0A: '#ebcb8b', base0B: '#a3be8c',
    base0C: '#88c0d0', base0D: '#81a1c1', base0E: '#b48ead', base0F: '#5e81ac'
};

const GRUVBOX_DARK_MEDIUM: Base16Palette = {
    base00: '#282828', base01: '#3c3836', base02: '#504945', base03: '#665c54',
    base04: '#bdae93', base05: '#d5c4a1', base06: '#ebdbb2', base07: '#fbf1c7',
    base08: '#fb4934', base09: '#fe8019', base0A: '#fabd2f', base0B: '#b8bb26',
    base0C: '#8ec07c', base0D: '#83a598', base0E: '#d3869b', base0F: '#d65d0e'
};

const SOLARIZED_DARK: Base16Palette = {
    base00: '#002b36', base01: '#073642', base02: '#586e75', base03: '#657b83',
    base04: '#839496', base05: '#93a1a1', base06: '#eee8d5', base07: '#fdf6e3',
    base08: '#dc322f', base09: '#cb4b16', base0A: '#b58900', base0B: '#859900',
    base0C: '#2aa198', base0D: '#268bd2', base0E: '#6c71c4', base0F: '#d33682'
};

const ONE_DARK: Base16Palette = {
    base00: '#282c34', base01: '#353b45', base02: '#3e4451', base03: '#545862',
    base04: '#565c64', base05: '#abb2bf', base06: '#b6bdca', base07: '#c8ccd4',
    base08: '#e06c75', base09: '#d19a66', base0A: '#e5c07b', base0B: '#98c379',
    base0C: '#56b6c2', base0D: '#61afef', base0E: '#c678dd', base0F: '#be5046'
};

const TOKYO_NIGHT_DARK: Base16Palette = {
    base00: '#1a1b26', base01: '#1f2335', base02: '#24283b', base03: '#414868',
    base04: '#787c99', base05: '#a9b1d6', base06: '#c0caf5', base07: '#d5d6db',
    base08: '#f7768e', base09: '#ff9e64', base0A: '#e0af68', base0B: '#9ece6a',
    base0C: '#73daca', base0D: '#7aa2f7', base0E: '#bb9af7', base0F: '#cfc9c2'
};

const MONOKAI: Base16Palette = {
    base00: '#272822', base01: '#383830', base02: '#49483e', base03: '#75715e',
    base04: '#a59f85', base05: '#f8f8f2', base06: '#f5f4f1', base07: '#f9f8f5',
    base08: '#f92672', base09: '#fd971f', base0A: '#f4bf75', base0B: '#a6e22e',
    base0C: '#a1efe4', base0D: '#66d9ef', base0E: '#ae81ff', base0F: '#cc6633'
};

const CATPPUCCIN_MOCHA: Base16Palette = {
    base00: '#1e1e2e', base01: '#181825', base02: '#313244', base03: '#45475a',
    base04: '#585b70', base05: '#cdd6f4', base06: '#f5e0dc', base07: '#b4befe',
    base08: '#f38ba8', base09: '#fab387', base0A: '#f9e2af', base0B: '#a6e3a1',
    base0C: '#94e2d5', base0D: '#89b4fa', base0E: '#cba6f7', base0F: '#f2cdcd'
};

const MATERIAL_DARKER: Base16Palette = {
    base00: '#212121', base01: '#303030', base02: '#353535', base03: '#4a4a4a',
    base04: '#b2ccd6', base05: '#eeffff', base06: '#eeffff', base07: '#ffffff',
    base08: '#f07178', base09: '#f78c6c', base0A: '#ffcb6b', base0B: '#c3e88d',
    base0C: '#89ddff', base0D: '#82aaff', base0E: '#c792ea', base0F: '#ff5370'
};

const OCEAN: Base16Palette = {
    base00: '#2b303b', base01: '#343d46', base02: '#4f5b66', base03: '#65737e',
    base04: '#a7adba', base05: '#c0c5ce', base06: '#dfe1e8', base07: '#eff1f5',
    base08: '#bf616a', base09: '#d08770', base0A: '#ebcb8b', base0B: '#a3be8c',
    base0C: '#96b5b4', base0D: '#8fa1b3', base0E: '#b48ead', base0F: '#ab7967'
};

const AYU_MIRAGE: Base16Palette = {
    base00: '#1f2430', base01: '#191e2a', base02: '#33415e', base03: '#707a8c',
    base04: '#8a9199', base05: '#cbccc6', base06: '#d9d7ce', base07: '#f3f4f5',
    base08: '#f28779', base09: '#ffad66', base0A: '#ffcc66', base0B: '#bae67e',
    base0C: '#95e6cb', base0D: '#5ccfe6', base0E: '#d4bfff', base0F: '#f29e74'
};

/* ------------------------------------------------------------------------- *
 * Light schemes (15)
 * ------------------------------------------------------------------------- */

const DEFAULT_LIGHT: Base16Palette = {
    base00: '#f8f8f8', base01: '#e8e8e8', base02: '#d8d8d8', base03: '#b8b8b8',
    base04: '#585858', base05: '#383838', base06: '#282828', base07: '#181818',
    base08: '#ab4642', base09: '#dc9656', base0A: '#f7ca88', base0B: '#a1b56c',
    base0C: '#86c1b9', base0D: '#7cafc2', base0E: '#ba8baf', base0F: '#a16946'
};

const TOMORROW_LIGHT: Base16Palette = {
    base00: '#ffffff', base01: '#e0e0e0', base02: '#d6d6d6', base03: '#8e908c',
    base04: '#969896', base05: '#4d4d4c', base06: '#282a2e', base07: '#1d1f21',
    base08: '#c82829', base09: '#f5871f', base0A: '#eab700', base0B: '#718c00',
    base0C: '#3e999f', base0D: '#4271ae', base0E: '#8959a8', base0F: '#a3685a'
};

const SOLARIZED_LIGHT: Base16Palette = {
    base00: '#fdf6e3', base01: '#eee8d5', base02: '#93a1a1', base03: '#839496',
    base04: '#657b83', base05: '#586e75', base06: '#073642', base07: '#002b36',
    base08: '#dc322f', base09: '#cb4b16', base0A: '#b58900', base0B: '#859900',
    base0C: '#2aa198', base0D: '#268bd2', base0E: '#6c71c4', base0F: '#d33682'
};

const GRUVBOX_LIGHT_MEDIUM: Base16Palette = {
    base00: '#fbf1c7', base01: '#ebdbb2', base02: '#d5c4a1', base03: '#bdae93',
    base04: '#665c54', base05: '#504945', base06: '#3c3836', base07: '#282828',
    base08: '#9d0006', base09: '#af3a03', base0A: '#b57614', base0B: '#79740e',
    base0C: '#427b58', base0D: '#076678', base0E: '#8f3f71', base0F: '#d65d0e'
};

const GITHUB_LIGHT: Base16Palette = {
    base00: '#ffffff', base01: '#f5f5f5', base02: '#c8c8fa', base03: '#969896',
    base04: '#e8e8e8', base05: '#333333', base06: '#ffffff', base07: '#ffffff',
    base08: '#ed6a43', base09: '#0086b3', base0A: '#795da3', base0B: '#183691',
    base0C: '#183691', base0D: '#795da3', base0E: '#a71d5d', base0F: '#333333'
};

const ONE_LIGHT: Base16Palette = {
    base00: '#fafafa', base01: '#f0f0f1', base02: '#e5e5e6', base03: '#a0a1a7',
    base04: '#696c77', base05: '#383a42', base06: '#202227', base07: '#090a0b',
    base08: '#ca1243', base09: '#d75f00', base0A: '#c18401', base0B: '#50a14f',
    base0C: '#0184bc', base0D: '#4078f2', base0E: '#a626a4', base0F: '#986801'
};

const ATELIER_FOREST_LIGHT: Base16Palette = {
    base00: '#f1efee', base01: '#e6e2e0', base02: '#a8a19f', base03: '#9c9491',
    base04: '#766e6b', base05: '#68615e', base06: '#2c2421', base07: '#1b1918',
    base08: '#f22c40', base09: '#df5320', base0A: '#c38418', base0B: '#7b9726',
    base0C: '#3d97b8', base0D: '#407ee7', base0E: '#6666ea', base0F: '#c33ff3'
};

const MATERIAL_LIGHTER: Base16Palette = {
    base00: '#fafafa', base01: '#e7eaec', base02: '#cceae7', base03: '#ccd7da',
    base04: '#8796b0', base05: '#80cbc4', base06: '#80cbc4', base07: '#ffffff',
    base08: '#ff5370', base09: '#f76d47', base0A: '#ffb62c', base0B: '#91b859',
    base0C: '#39adb5', base0D: '#6182b8', base0E: '#7c4dff', base0F: '#e53935'
};

const CUPCAKE: Base16Palette = {
    base00: '#fbf1f2', base01: '#f2f1f4', base02: '#d8d5dd', base03: '#bfb9c6',
    base04: '#a59daf', base05: '#8b8198', base06: '#72677e', base07: '#585062',
    base08: '#d57e85', base09: '#ebb790', base0A: '#dcb16c', base0B: '#a3b367',
    base0C: '#69a9a7', base0D: '#7297b9', base0E: '#bb99b4', base0F: '#baa58c'
};

const AYU_LIGHT: Base16Palette = {
    base00: '#fafafa', base01: '#f3f4f5', base02: '#f0eee4', base03: '#abb0b6',
    base04: '#828c99', base05: '#5c6773', base06: '#242936', base07: '#1a1f29',
    base08: '#f07171', base09: '#fa8d3e', base0A: '#f2ae49', base0B: '#86b300',
    base0C: '#4cbf99', base0D: '#36a3d9', base0E: '#a37acc', base0F: '#e6ba7e'
};

const CATPPUCCIN_LATTE: Base16Palette = {
    base00: '#eff1f5', base01: '#e6e9ef', base02: '#dce0e8', base03: '#acb0be',
    base04: '#8c8fa1', base05: '#4c4f69', base06: '#dc8a78', base07: '#7287fd',
    base08: '#d20f39', base09: '#fe640b', base0A: '#df8e1d', base0B: '#40a02b',
    base0C: '#179299', base0D: '#1e66f5', base0E: '#8839ef', base0F: '#dd7878'
};

const MEXICO_LIGHT: Base16Palette = {
    base00: '#f8f8f8', base01: '#e8e8e8', base02: '#d8d8d8', base03: '#b8b8b8',
    base04: '#585858', base05: '#383838', base06: '#282828', base07: '#181818',
    base08: '#ab4642', base09: '#dc9656', base0A: '#f79a0e', base0B: '#538947',
    base0C: '#4b8093', base0D: '#7cafc2', base0E: '#96609e', base0F: '#a16946'
};

const IA_LIGHT: Base16Palette = {
    base00: '#f6f6f6', base01: '#dedede', base02: '#bde5f2', base03: '#898989',
    base04: '#767676', base05: '#181818', base06: '#e8e8e8', base07: '#f8f8f8',
    base08: '#9c5a90', base09: '#c43e18', base0A: '#c48218', base0B: '#38781c',
    base0C: '#2d6bb1', base0D: '#48bac2', base0E: '#a94598', base0F: '#8b6c37'
};

const SHAPESHIFTER_LIGHT: Base16Palette = {
    base00: '#f9f9f9', base01: '#e0e0e0', base02: '#ababab', base03: '#555555',
    base04: '#343434', base05: '#102015', base06: '#040404', base07: '#000000',
    base08: '#e92f2f', base09: '#e09448', base0A: '#dddd13', base0B: '#0ed839',
    base0C: '#23edda', base0D: '#3b48e3', base0E: '#f996e2', base0F: '#69542d'
};

const UNIKITTY_LIGHT: Base16Palette = {
    base00: '#ffffff', base01: '#f5e3f0', base02: '#f1c4e6', base03: '#a7adba',
    base04: '#83758d', base05: '#0b0a09', base06: '#000000', base07: '#000000',
    base08: '#d8137f', base09: '#d65407', base0A: '#dc8a0e', base0B: '#17ad98',
    base0C: '#149bda', base0D: '#796af5', base0E: '#bb60ea', base0F: '#c720ca'
};

/* ------------------------------------------------------------------------- *
 * Registry
 * ------------------------------------------------------------------------- */

const DARK_THEMES: readonly CodeTheme[] = [
    { id: 'hybrid', label: 'Hybrid (default)', kind: 'dark', palette: HYBRID },
    { id: 'tomorrow-night', label: 'Tomorrow Night', kind: 'dark', palette: TOMORROW_NIGHT },
    { id: 'tomorrow-night-eighties', label: 'Tomorrow Night Eighties', kind: 'dark', palette: TOMORROW_NIGHT_EIGHTIES },
    { id: 'default-dark', label: 'Default Dark', kind: 'dark', palette: DEFAULT_DARK },
    { id: 'dracula', label: 'Dracula', kind: 'dark', palette: DRACULA },
    { id: 'nord', label: 'Nord', kind: 'dark', palette: NORD },
    { id: 'gruvbox-dark-medium', label: 'Gruvbox Dark', kind: 'dark', palette: GRUVBOX_DARK_MEDIUM },
    { id: 'solarized-dark', label: 'Solarized Dark', kind: 'dark', palette: SOLARIZED_DARK },
    { id: 'one-dark', label: 'One Dark', kind: 'dark', palette: ONE_DARK },
    { id: 'tokyo-night-dark', label: 'Tokyo Night', kind: 'dark', palette: TOKYO_NIGHT_DARK },
    { id: 'monokai', label: 'Monokai', kind: 'dark', palette: MONOKAI },
    { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', kind: 'dark', palette: CATPPUCCIN_MOCHA },
    { id: 'material-darker', label: 'Material Darker', kind: 'dark', palette: MATERIAL_DARKER },
    { id: 'ocean', label: 'Ocean', kind: 'dark', palette: OCEAN },
    { id: 'ayu-mirage', label: 'Ayu Mirage', kind: 'dark', palette: AYU_MIRAGE }
];

const LIGHT_THEMES: readonly CodeTheme[] = [
    { id: 'default-light', label: 'Default Light', kind: 'light', palette: DEFAULT_LIGHT },
    { id: 'tomorrow-light', label: 'Tomorrow', kind: 'light', palette: TOMORROW_LIGHT },
    { id: 'solarized-light', label: 'Solarized Light', kind: 'light', palette: SOLARIZED_LIGHT },
    { id: 'gruvbox-light-medium', label: 'Gruvbox Light', kind: 'light', palette: GRUVBOX_LIGHT_MEDIUM },
    { id: 'github-light', label: 'GitHub Light', kind: 'light', palette: GITHUB_LIGHT },
    { id: 'one-light', label: 'One Light', kind: 'light', palette: ONE_LIGHT },
    { id: 'atelier-forest-light', label: 'Atelier Forest Light', kind: 'light', palette: ATELIER_FOREST_LIGHT },
    { id: 'material-lighter', label: 'Material Lighter', kind: 'light', palette: MATERIAL_LIGHTER },
    { id: 'cupcake', label: 'Cupcake', kind: 'light', palette: CUPCAKE },
    { id: 'ayu-light', label: 'Ayu Light', kind: 'light', palette: AYU_LIGHT },
    { id: 'catppuccin-latte', label: 'Catppuccin Latte', kind: 'light', palette: CATPPUCCIN_LATTE },
    { id: 'mexico-light', label: 'Mexico Light', kind: 'light', palette: MEXICO_LIGHT },
    { id: 'ia-light', label: 'iA Light', kind: 'light', palette: IA_LIGHT },
    { id: 'shapeshifter-light', label: 'Shapeshifter Light', kind: 'light', palette: SHAPESHIFTER_LIGHT },
    { id: 'unikitty-light', label: 'Unikitty Light', kind: 'light', palette: UNIKITTY_LIGHT }
];

export const CODE_THEMES: readonly CodeTheme[] = [
    ...DARK_THEMES,
    ...LIGHT_THEMES
];

export const DEFAULT_CODE_THEME_ID = 'hybrid';

const THEME_INDEX: ReadonlyMap<string, CodeTheme> = new Map(
    CODE_THEMES.map((t) => [t.id, t])
);

/**
 * Look up a theme by id, falling back to the default when the id is unknown
 * (or undefined). The fallback keeps misspelled / outdated settings from
 * breaking the render — the user just sees the default palette until they
 * fix the setting value.
 */
export function getCodeTheme(id?: string): CodeTheme {
    if (id) {
        const found = THEME_INDEX.get(id);
        if (found) return found;
    }
    return THEME_INDEX.get(DEFAULT_CODE_THEME_ID)!;
}

/**
 * Render a theme's hljs-slot mapping as the body of a CSS variable
 * declaration block (no enclosing selector). The caller is expected to
 * wrap this in either a `:root { ... }` block at first paint or to swap
 * it into an existing live `<style>` element for live theme changes.
 *
 * The slot mapping mirrors the canonical highlight.js base16 family —
 * keyword=base0E, type/builtin=base0A, function/title=base0D,
 * string=base0B, number=base09, comment=base03, etc.
 */
/**
 * Lightweight menu entry shape — what the webview-client needs to render
 * the picker. Excludes the palette so the bootstrap payload stays small
 * (the active palette ships as concrete CSS variables instead).
 */
export interface CodeThemeMenuEntry {
    id: string;
    label: string;
    kind: 'dark' | 'light';
}

export function getCodeThemeMenuEntries(): readonly CodeThemeMenuEntry[] {
    return CODE_THEMES.map((t) => ({ id: t.id, label: t.label, kind: t.kind }));
}

export function buildCodeThemeCssVars(theme: CodeTheme): string {
    const p = theme.palette;
    return [
        `--cppref-hljs-bg: ${p.base00};`,
        `--cppref-hljs-fg: ${p.base05};`,
        `--cppref-hljs-selection: ${p.base02};`,
        `--cppref-hljs-comment: ${p.base03};`,
        `--cppref-hljs-number: ${p.base09};`,
        `--cppref-hljs-string: ${p.base0B};`,
        `--cppref-hljs-keyword: ${p.base0E};`,
        `--cppref-hljs-type: ${p.base0A};`,
        `--cppref-hljs-title: ${p.base0D};`,
        `--cppref-hljs-variable: ${p.base0C};`,
        `--cppref-hljs-attribute: ${p.base0E};`,
        `--cppref-hljs-deprecated: ${p.base0F};`
    ].join(' ');
}
