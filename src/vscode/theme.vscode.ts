// Central theme detection and icon utilities
// VS Code's activeColorTheme.kind takes precedence over system settings

import * as vscode from 'vscode';
import * as path from 'path';
import { BUILT_IN_AGENTS } from '../core/agents';

// Icons that have light variants (dark logo for light backgrounds)
const ICONS_WITH_LIGHT_VARIANTS = new Set([
  'chatgpt.png',
  'cursor.png',
  // Grok's and Droid's marks are monochrome white — a dark-on-light variant keeps
  // them legible on the light/cream terminal tab bar.
  'grok.png',
  'droid.png'
]);

/**
 * Get the light variant filename for an icon (if it exists).
 * e.g., "chatgpt.png" -> "chatgpt-light.png"
 */
function getLightVariant(iconFilename: string): string | null {
  if (!ICONS_WITH_LIGHT_VARIANTS.has(iconFilename)) {
    return null;
  }
  const ext = path.extname(iconFilename);
  const base = path.basename(iconFilename, ext);
  return `${base}-light${ext}`;
}

/**
 * Build VS Code icon path with light/dark variants.
 * For icons with light variants: uses {icon}-light.png for light theme, {icon}.png for dark.
 * For icons without variants: uses the same file for both.
 */
export function buildIconPath(extensionPath: string, iconFilename: string): vscode.IconPath {
  const assetsPath = path.join(extensionPath, 'assets');
  const darkIcon = vscode.Uri.file(path.join(assetsPath, iconFilename));

  const lightVariant = getLightVariant(iconFilename);
  const lightIcon = lightVariant
    ? vscode.Uri.file(path.join(assetsPath, lightVariant))
    : darkIcon;

  return { light: lightIcon, dark: darkIcon };
}

/**
 * Build icon path using extension URI (for webview contexts).
 * Returns the specific { light: Uri; dark: Uri } shape for panel.iconPath.
 */
function buildIconPathFromUri(extensionUri: vscode.Uri, iconFilename: string): { light: vscode.Uri; dark: vscode.Uri } {
  const darkIcon = vscode.Uri.joinPath(extensionUri, 'assets', iconFilename);

  const lightVariant = getLightVariant(iconFilename);
  const lightIcon = lightVariant
    ? vscode.Uri.joinPath(extensionUri, 'assets', lightVariant)
    : darkIcon;

  return { light: lightIcon, dark: darkIcon };
}

/** One class per built-in agent (`.hx-claude`), each drawing that agent's logo from
 *  assets/, with the light variant on a light editor theme. Both sidebars draw a
 *  logo only through these classes. */
export function harnessLogoCss(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return BUILT_IN_AGENTS.map((a) => {
    const { dark, light } = buildIconPathFromUri(extensionUri, a.icon);
    return `.hx-${a.key} { background-image: url("${webview.asWebviewUri(dark)}"); } body.vscode-light .hx-${a.key} { background-image: url("${webview.asWebviewUri(light)}"); }`;
  }).join('\n  ');
}
