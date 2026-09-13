import * as vscode from 'vscode';
import {
  type EditorAssociations,
  normalizeEditorAssociations,
  withReaderEditorAssociations,
} from '../core/editorAssociations';

/**
 * Update multiple VS Code settings at once.
 * Keys use dot notation (e.g., 'workbench.sideBar.location').
 */
async function updateSettings(
  settings: Record<string, unknown>,
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Promise<void> {
  for (const [key, value] of Object.entries(settings)) {
    // Split key into section and property (e.g., 'workbench.sideBar.location' -> 'workbench', 'sideBar.location')
    const firstDot = key.indexOf('.');
    if (firstDot === -1) {
      throw new Error(`Invalid setting key: ${key}. Must include section (e.g., 'workbench.sideBar.location')`);
    }
    const section = key.slice(0, firstDot);
    const property = key.slice(firstDot + 1);

    const config = vscode.workspace.getConfiguration(section);
    await config.update(property, value, target);
  }
}

/**
 * Read a VS Code setting value.
 */
function getSetting<T>(key: string): T | undefined {
  const firstDot = key.indexOf('.');
  if (firstDot === -1) {
    throw new Error(`Invalid setting key: ${key}. Must include section (e.g., 'workbench.sideBar.location')`);
  }
  const section = key.slice(0, firstDot);
  const property = key.slice(firstDot + 1);

  const config = vscode.workspace.getConfiguration(section);
  return config.get<T>(property);
}

function getEditorAssociations(): EditorAssociations {
  return normalizeEditorAssociations(getSetting<unknown>('workbench.editorAssociations'));
}

async function setEditorAssociations(associations: EditorAssociations): Promise<void> {
  await updateSettings({ 'workbench.editorAssociations': associations });
}

/** Wire *.md + *.html/*.htm to the Agents Reader custom editors (or default off). */
export async function setMarkdownEditorAssociation(enabled: boolean): Promise<void> {
  const next = withReaderEditorAssociations(getEditorAssociations(), enabled);
  await setEditorAssociations(next);
}
