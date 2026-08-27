import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let currentPanel: vscode.WebviewPanel | undefined;
let currentHtmlPath: string | undefined;

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

    context.subscriptions.push(disposable);
}

function openPreview(uri: vscode.Uri) {
    const filePath = uri.fsPath;
    const fileName = path.basename(filePath);
    const fileDir = path.dirname(filePath);
    currentHtmlPath = filePath;

    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
        updateWebviewContent(currentPanel, filePath);
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

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
        currentHtmlPath = undefined;
    });

    // Auto-refresh preview when the HTML file is saved
    const saveListener = vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
        if (currentPanel && currentHtmlPath && doc.uri.fsPath === currentHtmlPath) {
            updateWebviewContent(currentPanel, currentHtmlPath);
        }
    });

    currentPanel.onDidDispose(() => {
        saveListener.dispose();
    });

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
        changeEditorListener.dispose();
    });
}

function updateWebviewContent(panel: vscode.WebviewPanel, htmlPath: string) {
    try {
        const baseDir = path.dirname(htmlPath);
        let htmlContent = fs.readFileSync(htmlPath, 'utf-8');

        const webview = panel.webview;

        // Rewrite local resource paths to webview URIs
        htmlContent = rewriteResourcePaths(htmlContent, baseDir, webview);

        // Build a permissive Content Security Policy for the preview
        const csp = [
            `<meta http-equiv="Content-Security-Policy" content="`,
            `default-src 'none';`,
            `script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource};`,
            `style-src 'unsafe-inline' ${webview.cspSource};`,
            `img-src ${webview.cspSource} data: blob: https: http:;`,
            `font-src ${webview.cspSource} data:;`,
            `connect-src ${webview.cspSource} https: http:;`,
            `frame-src ${webview.cspSource} https: http:;`,
            `media-src ${webview.cspSource} data: blob:;`,
            `">`,
        ].join('\n');

        // Inject CSP into the HTML
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

        if (/<head[^>]*>/i.test(htmlContent)) {
            htmlContent = htmlContent.replace(/<head[^>]*>/i, (match: string) => `${match}\n${csp}\n${externalLinkScript}`);
        } else if (/<html[^>]*>/i.test(htmlContent)) {
            htmlContent = htmlContent.replace(/<html[^>]*>/i, (match: string) => `${match}\n<head>\n${csp}\n${externalLinkScript}\n</head>`);
        } else {
            // HTML fragment, wrap into a full document
            htmlContent = `<!DOCTYPE html>\n<html lang="en">\n<head>\n${csp}\n${externalLinkScript}\n<meta charset="utf-8">\n</head>\n<body>\n${htmlContent}\n</body>\n</html>`;
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