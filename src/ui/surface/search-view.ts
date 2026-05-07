import * as vscode from 'vscode';

export const SEARCH_VIEW_ID = 'cppDocs.searchView';

export class SearchViewController implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    private messageDisposable: vscode.Disposable | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly onSearch: (query: string) => void
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.messageDisposable?.dispose();
        this.messageDisposable = undefined;
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        view.webview.html = this.buildHtml();
        this.messageDisposable = view.webview.onDidReceiveMessage((msg: { type: string; query?: string }) => {
            if (msg.type === 'search') {
                this.onSearch(msg.query ?? '');
            }
        });
    }

    clearSearch(): void {
        this.view?.webview.postMessage({ type: 'clear' });
    }

    private buildHtml(): string {
        const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
            .map(b => b.toString(16).padStart(2, '0')).join('');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    padding: 4px 8px 6px;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-sideBar-foreground);
  }
  .row {
    display: flex;
    align-items: center;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    padding: 0 6px;
    gap: 5px;
    height: 26px;
  }
  .row:focus-within {
    border-color: var(--vscode-focusBorder);
    outline: none;
  }
  .icon {
    color: var(--vscode-input-placeholderForeground);
    font-size: 13px;
    flex-shrink: 0;
    line-height: 1;
    user-select: none;
  }
  input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    min-width: 0;
  }
  input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }
  .clear {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--vscode-input-placeholderForeground);
    font-size: 11px;
    padding: 0;
    line-height: 1;
    flex-shrink: 0;
    display: none;
    user-select: none;
  }
  .clear.show { display: block; }
  .clear:hover { color: var(--vscode-input-foreground); }
</style>
</head>
<body>
<div class="row">
  <span class="icon">&#x2315;</span>
  <input id="q" type="text" placeholder="Search C++ docs…" autocomplete="off" spellcheck="false">
  <button class="clear" id="clr" title="Clear">✕</button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q');
  const clr = document.getElementById('clr');
  let t;

  q.addEventListener('input', () => {
    clearTimeout(t);
    clr.classList.toggle('show', q.value.length > 0);
    t = setTimeout(() => vscode.postMessage({ type: 'search', query: q.value }), 150);
  });

  q.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      q.value = '';
      clr.classList.remove('show');
      clearTimeout(t);
      vscode.postMessage({ type: 'search', query: '' });
    }
  });

  clr.addEventListener('click', () => {
    q.value = '';
    clr.classList.remove('show');
    clearTimeout(t);
    vscode.postMessage({ type: 'search', query: '' });
    q.focus();
  });

  window.addEventListener('message', e => {
    if (e.data?.type === 'clear') {
      q.value = '';
      clr.classList.remove('show');
    }
  });
</script>
</body>
</html>`;
    }
}
