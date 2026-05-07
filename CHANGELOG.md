# Changelog

## [0.1.0] - 2026-05-22

Initial public release.

### Added
- Offline cppreference docset installer that downloads the latest [PeterFeicht/cppreference-doc](https://github.com/PeterFeicht/cppreference-doc) release, verifies the SHA-256 checksum, extracts it, and indexes the bundled Doxygen tag XML.
- Cursor-follow documentation panel: as the cursor moves over a resolvable C/C++ symbol, the panel auto-navigates to the matching cppreference page. Resolver chain: clangd `textDocument/symbolInfo` → hover-text parsing → definition lookup → identifier-based fallback.
- Hover provider that injects cppreference snippets alongside clangd / MS C/C++ hover content.
- Symbol browser tree view in the activity bar with live filter-as-you-type narrowing.
- Flexible panel placement: docs panel can live in the primary sidebar, secondary sidebar, bottom panel, or any editor column. A `WebviewPanelSerializer` restores the last-viewed page on VS Code restart.
- C++ standard filtering (C++11 / 14 / 17 / 20 / 23 / 26) with `auto` mode resolving from `C_Cpp.default.cppStandard`, then `compile_commands.json`, then a configurable fallback. Filtering is CSS-only and toggles live without re-render.
- Theme-aware rendering: page colors track the active VS Code theme (light, dark, high-contrast) via CSS variables.
- In-panel code-snippet theme picker with 30 highlight.js themes (15 dark, 15 light); selection persists across sessions.
- Floating zoom and navigation (back / forward) controls in the docs panel.
- Commands: Open Symbol, Install cppreference, Check for Updates, Remove Docset, Set C++ Standard, Toggle Docs Panel, Move to Editor Tab, Dock in Side/Bottom Panel, Open Current Page in Browser, Diagnose Symbol Under Cursor, and more.
- Configurable docsets root directory and pinnable cppreference release version.
- cppreference attribution footer rendered on every page (CC BY-SA 3.0 compliance); visibility toggleable via setting.

[0.1.0]: https://github.com/vorlac/vscode-cpp-docs-extension/releases/tag/v0.1.0
