import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let currentPanel: vscode.WebviewPanel | undefined;
let currentHtmlPath: string | undefined;

// Auto-refresh infrastructure: the preview refreshes lazily (only while it is
// visible) and is debounced to coalesce bursts of file changes.
const REFRESH_DEBOUNCE_MS = 300;
const WATCH_GLOB = '**/*.{html,htm,css,js,mjs,json,map,png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,eot,mp4,webm,mp3,wav,ogg}';
let sourceWatcher: vscode.FileSystemWatcher | undefined;
let watchedDir: string | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let refreshPending = false;

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('html-preview-plus.openPreview', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor found.');
            return;
        }

        const document = editor.document;
        if (document.languageId !== 'html') {
            vscode.window.showWarningMessage('Active editor is not an HTML file.');
            return;
        }

        openPreview(document.uri);
    });

    // Manual refresh entry points (command palette / webview refresh button)
    const refreshDisposable = vscode.commands.registerCommand('html-preview-plus.refreshPreview', () => {
        if (!currentPanel || !currentHtmlPath) {
            vscode.window.showWarningMessage('No active preview. Open the preview first.');
            return;
        }
        refreshPreviewNow();
    });

    // Open an HTML file in the system default browser. The button is shown
    // both on HTML source tabs (editor/title, resourceLangId == html) and on
    // the preview tab (activeWebviewPanelId == htmlPreview). Prefer the
    // active HTML editor as the target (source-tab clicks, and the usual
    // side-by-side flow where the editor shows the same file as the preview);
    // fall back to the previewed file when no HTML editor is active.
    const openInBrowserDisposable = vscode.commands.registerCommand('html-preview-plus.openInBrowser', async () => {
        const editor = vscode.window.activeTextEditor;
        const sourcePath = editor && editor.document.languageId === 'html' ? editor.document.uri.fsPath : undefined;
        const target = sourcePath || (currentPanel && currentHtmlPath ? currentHtmlPath : undefined);
        if (!target) {
            vscode.window.showWarningMessage('No HTML file to open. Open an HTML file or the preview first.');
            return;
        }
        const opened = await vscode.env.openExternal(vscode.Uri.file(target));
        if (!opened) {
            vscode.window.showErrorMessage('Failed to open the file in the default browser.');
        }
    });

    context.subscriptions.push(disposable, refreshDisposable, openInBrowserDisposable);
}

function openPreview(uri: vscode.Uri) {
    const filePath = uri.fsPath;
    const fileName = path.basename(filePath);
    const fileDir = path.dirname(filePath);
    currentHtmlPath = filePath;

    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
        updateWebviewContent(currentPanel, filePath);
        updateSourceWatcher(fileDir);
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'htmlPreview',
        `Preview: ${fileName}`,
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(fileDir),
                ...vscode.workspace.workspaceFolders?.map((f: vscode.WorkspaceFolder) => f.uri) ?? []
            ],
            enableFindWidget: true,
        }
    );

    updateWebviewContent(currentPanel, filePath);
    updateSourceWatcher(fileDir);

    // Auto-refresh when the HTML file is saved inside VS Code (the file
    // watcher below also catches this, but the save event fires earlier)
    const saveListener = vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
        if (currentPanel && currentHtmlPath && doc.uri.fsPath === currentHtmlPath) {
            onSourceChanged();
        }
    });

    // Lazy refresh: changes arriving while the preview is hidden only mark it
    // dirty; a single refresh happens once the panel becomes visible again.
    const viewStateListener = currentPanel.onDidChangeViewState((e: vscode.WebviewPanelOnDidChangeViewStateEvent) => {
        if (e.webviewPanel.visible && refreshPending) {
            refreshPending = false;
            scheduleRefresh();
        }
    });

    // Refresh request from the refresh button on the preview tab's title bar
    // (the button itself is contributed via editor/title menus with an
    // activeWebviewPanelId condition, so no webview message channel is needed).

    // Track editor switch: if user switches to a different HTML file, update preview
    const changeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
        if (currentPanel && editor && editor.document.languageId === 'html') {
            const newPath = editor.document.uri.fsPath;
            if (newPath !== currentHtmlPath) {
                currentPanel.title = `Preview: ${path.basename(newPath)}`;
            }
        }
    });

    currentPanel.onDidDispose(() => {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = undefined;
        }
        refreshPending = false;
        disposeSourceWatcher();
        saveListener.dispose();
        viewStateListener.dispose();
        changeEditorListener.dispose();
        currentPanel = undefined;
        currentHtmlPath = undefined;
    });
}

/**
 * Watch the previewed HTML file's directory for changes, including external
 * edits. Any change to a web resource under the directory schedules a
 * debounced, visibility-gated refresh.
 */
function updateSourceWatcher(dir: string) {
    if (sourceWatcher && watchedDir === dir) {
        return;
    }
    disposeSourceWatcher();
    watchedDir = dir;
    sourceWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, WATCH_GLOB));
    sourceWatcher.onDidChange(() => onSourceChanged());
    sourceWatcher.onDidCreate(() => onSourceChanged());
    // Deletions are ignored: removing a resource cannot be rendered anyway,
    // and deleting the HTML itself would only surface a read error.
}

function disposeSourceWatcher() {
    if (sourceWatcher) {
        sourceWatcher.dispose();
        sourceWatcher = undefined;
    }
    watchedDir = undefined;
}

/** Lazy refresh entry: skip while hidden (mark dirty), debounce while visible. */
function onSourceChanged() {
    if (!currentPanel || !currentHtmlPath) {
        return;
    }
    if (!currentPanel.visible) {
        refreshPending = true;
        return;
    }
    scheduleRefresh();
}

/** Debounced refresh of the preview content. */
function scheduleRefresh() {
    if (!currentPanel || !currentHtmlPath) {
        return;
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (currentPanel && currentHtmlPath) {
            updateWebviewContent(currentPanel, currentHtmlPath);
        }
    }, REFRESH_DEBOUNCE_MS);
}

/** Force an immediate refresh, cancelling any pending debounce/dirty state. */
function refreshPreviewNow() {
    if (!currentPanel || !currentHtmlPath) {
        return;
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
    }
    refreshPending = false;
    updateWebviewContent(currentPanel, currentHtmlPath);
}

function updateWebviewContent(panel: vscode.WebviewPanel, htmlPath: string) {
    try {
        const baseDir = path.dirname(htmlPath);
        let htmlContent = fs.readFileSync(htmlPath, 'utf-8');

        const webview = panel.webview;

        // Rewrite local resource paths to webview URIs
        htmlContent = rewriteResourcePaths(htmlContent, baseDir, webview);

        // Build a permissive Content Security Policy for the preview. Remote
        // http(s) sources are allowed so pages can load third-party libraries
        // from CDNs (e.g. ECharts, jQuery) exactly as they would in a browser.
        const remote = 'https: http:';
        const csp = [
            `<meta http-equiv="Content-Security-Policy" content="`,
            `default-src 'none';`,
            `script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} ${remote};`,
            `style-src 'unsafe-inline' ${webview.cspSource} ${remote};`,
            `img-src ${webview.cspSource} data: blob: ${remote};`,
            `font-src ${webview.cspSource} data: ${remote};`,
            `connect-src ${webview.cspSource} ${remote};`,
            `frame-src ${webview.cspSource} ${remote};`,
            `media-src ${webview.cspSource} data: blob:;`,
            `">`,
        ].join('\n');

        // Inject CSP and helper scripts into the HTML
        const externalLinkScript = [
            '<script>',
            '(function(){',
            '  document.addEventListener("click", function(e) {',
            '    var target = e.target.closest("a[href]");',
            '    if (!target) return;',
            '    var href = target.getAttribute("href");',
            '    if (/^https?:\\/\\//i.test(href)) {',
            '      e.preventDefault();',
            '      window.open(href, "_blank");',
            '    }',
            '  });',
            '})();',
            '</script>',
        ].join('\n');

        // Resize relay: when the preview panel is resized (e.g. dragged wider)
        // the page's window resize event may not fire reliably inside the
        // webview, so page code that adapts to its container by listening on
        // window resize (chart libraries, responsive layouts) never re-layouts.
        // A ResizeObserver on <html> catches every real viewport size change;
        // when the size actually changed we re-dispatch a synthetic resize
        // event, so pages behave exactly as they would in a browser — no
        // library-specific handling needed here. The debounce coalesces drag
        // bursts, and the size check both suppresses the observer's initial
        // callback and guards against relay loops.
        const resizeRelayScript = [
            '<script>',
            '(function(){',
            '  if (typeof ResizeObserver === "undefined") return;',
            '  var lastW = -1, lastH = -1, timer = null;',
            '  function relay() {',
            '    var w = document.documentElement.clientWidth;',
            '    var h = document.documentElement.clientHeight;',
            '    if (w === lastW && h === lastH) return;',
            '    lastW = w; lastH = h;',
            '    window.dispatchEvent(new Event("resize"));',
            '  }',
            '  var observer = new ResizeObserver(function() {',
            '    if (timer) return;',
            '    timer = setTimeout(function() { timer = null; relay(); }, 100);',
            '  });',
            '  function start() {',
            '    var el = document.documentElement;',
            '    lastW = el.clientWidth; lastH = el.clientHeight;',
            '    observer.observe(el);',
            '  }',
            '  if (document.documentElement) start();',
            '  else document.addEventListener("DOMContentLoaded", start);',
            '})();',
            '</script>',
        ].join('\n');
        const uiInjection = `${csp}\n${externalLinkScript}\n${resizeRelayScript}`;

        if (/<head[^>]*>/i.test(htmlContent)) {
            htmlContent = htmlContent.replace(/<head[^>]*>/i, (match: string) => `${match}\n${uiInjection}`);
        } else if (/<html[^>]*>/i.test(htmlContent)) {
            htmlContent = htmlContent.replace(/<html[^>]*>/i, (match: string) => `${match}\n<head>\n${uiInjection}\n</head>`);
        } else {
            // HTML fragment, wrap into a full document
            htmlContent = `<!DOCTYPE html>\n<html lang="en">\n<head>\n${uiInjection}\n<meta charset="utf-8">\n</head>\n<body>\n${htmlContent}\n</body>\n</html>`;
        }

        // Update panel title
        panel.title = `Preview: ${path.basename(htmlPath)}`;

        webview.html = htmlContent;
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to read HTML file: ${err}`);
    }
}

/**
 * Rewrite local resource references (src, href, srcset, etc.)
 * from file-relative paths to VS Code webview URIs.
 */
function rewriteResourcePaths(html: string, baseDir: string, webview: vscode.Webview): string {
    // Helper: resolve a resource path to a webview URI
    const resolve = (resourcePath: string): string => {
        const trimmed = resourcePath.trim();

        // Skip if already a URI scheme or an anchor/dynamic path
        if (
            /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed) ||
            trimmed.startsWith('#') ||
            trimmed.startsWith('//') ||
            // Skip template expressions like ${...} or {{...}}
            /\$\{/.test(trimmed) ||
            /\{\{/.test(trimmed)
        ) {
            return trimmed;
        }

        try {
            const resolvedPath = path.resolve(baseDir, trimmed);
            const fileUri = vscode.Uri.file(resolvedPath);
            return webview.asWebviewUri(fileUri).toString();
        } catch {
            return trimmed;
        }
    };

    // Rewrite src="..." attributes (skip external URLs and templates)
    html = html.replace(
        /(\s+src\s*=\s*["'])([^"']+)(["'])/gi,
        (match: string, prefix: string, src: string, suffix: string) => {
            const trimmed = src.trim();
            if (
                trimmed.startsWith('data:') ||
                /^https?:\/\//i.test(trimmed) ||
                /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed) ||
                /\$\{/.test(trimmed) ||
                /\{\{/.test(trimmed)
            ) {
                return match;
            }
            return `${prefix}${resolve(trimmed)}${suffix}`;
        }
    );

    // Rewrite href="..." attributes (skip anchors, data URIs, external URLs, and templates)
    html = html.replace(
        /(\s+href\s*=\s*["'])([^"']+)(["'])/gi,
        (match: string, prefix: string, href: string, suffix: string) => {
            const trimmed = href.trim();
            if (
                trimmed.startsWith('#') ||
                trimmed.startsWith('data:') ||
                /^https?:\/\//i.test(trimmed) ||
                /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed) ||
                /\$\{/.test(trimmed) ||
                /\{\{/.test(trimmed)
            ) {
                return match;
            }
            return `${prefix}${resolve(trimmed)}${suffix}`;
        }
    );

    // Rewrite srcset="..." attributes (comma-separated URLs with optional descriptors)
    html = html.replace(
        /(\s+srcset\s*=\s*["'])([^"']+)(["'])/gi,
        (match: string, prefix: string, srcset: string, suffix: string) => {
            const entries = srcset.split(',').map((entry: string) => {
                const parts = entry.trim().split(/\s+/);
                if (parts.length === 0) return entry;
                const first = parts[0];
                if (
                    /^https?:\/\//i.test(first) ||
                    /\$\{/.test(first) ||
                    /\{\{/.test(first)
                ) {
                    return entry;
                }
                parts[0] = resolve(parts[0]);
                return parts.join(' ');
            });
            return `${prefix}${entries.join(', ')}${suffix}`;
        }
    );

    return html;
}

export function deactivate() {
    if (currentPanel) {
        currentPanel.dispose();
        currentPanel = undefined;
    }
}