# HTML Preview

Preview local HTML files in VS Code.

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/sevenid.html-preview-plus?color=blue&label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=sevenid.html-preview-plus)

![Screenshot](https://raw.githubusercontent.com/omgseven/resource/refs/heads/main/preview.jpg)

## Features

- Preview button appears in the editor title area when opening `.html` files
- Click the button to open a preview tab alongside the editor
- Loads local CSS, JavaScript, images and other resources from the same directory
- Click `http/https` links in the preview to open them in your default browser
- Auto-refresh the preview when the HTML file or its resources change (external edits included) — debounced, and only while the preview is visible

## Usage

1. Open any `.html` file
2. Click the preview button (eye icon) in the top-right corner of the editor
3. The preview panel opens on the right side
4. Click the refresh button (circular arrow icon) on the preview tab's title bar to reload it manually

## Installation

Search "HTML Preview" in the VS Code extension marketplace, or [open it directly](https://marketplace.visualstudio.com/items?itemName=sevenid.html-preview-plus).

To run locally:

```bash
git clone <repo-url>
cd html-preview
npm install
```

Then press `F5` in VS Code to launch the extension development host.

## Requirements

- VS Code 1.85+
- Node.js 20+

## License

MIT