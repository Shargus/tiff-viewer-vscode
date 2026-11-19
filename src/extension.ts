import * as vscode from 'vscode';
import { PresetStore } from './presetStore';
import { TiffEditorProvider } from './tiffEditor';

export function activate(context: vscode.ExtensionContext): void {
  const presets = new PresetStore();
  context.subscriptions.push(
    presets,
    TiffEditorProvider.register(context, presets),
    vscode.commands.registerCommand('tiffViewer.openPresets', () => presets.open()),
  );
  // Creates ~/.tiff-viewer-vscode/presets.jsonc on first run, so it is there to edit right after installing.
  void presets.init();
}

export function deactivate(): void {}
