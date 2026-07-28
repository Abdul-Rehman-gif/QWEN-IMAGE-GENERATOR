import * as vscode from 'vscode';
import { checkPrerequisitesCommand } from './prerequisites';
import { installComfyUI, installGGUFCustomNodes } from './installer';
import { downloadModels } from './downloader';
import { launchServer, stopServer } from './server';
import { generateImage } from './generate';
import { getOutputChannel } from './util';

export function activate(context: vscode.ExtensionContext) {
  const channel = getOutputChannel();

  context.subscriptions.push(
    vscode.commands.registerCommand('qwenImage.checkPrerequisites', checkPrerequisitesCommand),

    vscode.commands.registerCommand('qwenImage.installComfyUI', () => installComfyUI(channel)),

    vscode.commands.registerCommand('qwenImage.installGGUFNodes', () => installGGUFCustomNodes(channel)),

    vscode.commands.registerCommand('qwenImage.downloadModels', () => downloadModels(channel)),

    vscode.commands.registerCommand('qwenImage.launchServer', () => launchServer()),

    vscode.commands.registerCommand('qwenImage.stopServer', () => stopServer()),

    vscode.commands.registerCommand('qwenImage.generateImage', () => generateImage(context)),

    vscode.commands.registerCommand('qwenImage.setupAll', async () => {
      vscode.window.showInformationMessage('Starting full Qwen-Image setup: install → download models → launch server.');
      const installed = await installComfyUI(channel);
      if (!installed) {
        return;
      }
      const downloaded = await downloadModels(channel);
      if (!downloaded) {
        return;
      }
      await launchServer();
      vscode.window.showInformationMessage('Setup complete! Run "Qwen-Image: Generate Image" to create your first image.');
    })
  );

  channel.appendLine('Qwen-Image Local Runner extension activated.');
}

export function deactivate() {
  stopServer();
}
