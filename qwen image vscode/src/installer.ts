import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getInstallDir, ensureDir, runCommand, getConfig, getOutputChannel } from './util';

const COMFYUI_REPO = 'https://github.com/comfyanonymous/ComfyUI.git';
const GGUF_NODES_REPO = 'https://github.com/city96/ComfyUI-GGUF.git';

export async function installGGUFCustomNodes(out: vscode.OutputChannel): Promise<boolean> {
  const installDir = getInstallDir();
  const pythonCmd = getConfig().get<string>('pythonPath', 'python');
  const customNodesDir = path.join(installDir, 'custom_nodes');
  const ggufNodeDir = path.join(customNodesDir, 'ComfyUI-GGUF');
  ensureDir(customNodesDir);

  if (fs.existsSync(path.join(ggufNodeDir, '.git'))) {
    out.appendLine('ComfyUI-GGUF already present, pulling latest...');
    await runCommand('git', ['pull'], out, { cwd: ggufNodeDir });
  } else {
    const ggufCloneCode = await runCommand('git', ['clone', GGUF_NODES_REPO, ggufNodeDir], out);
    if (ggufCloneCode !== 0) {
      vscode.window.showErrorMessage('Failed to clone ComfyUI-GGUF. Check the Output panel.');
      return false;
    }
  }

  const ggufReqFile = path.join(ggufNodeDir, 'requirements.txt');
  if (fs.existsSync(ggufReqFile)) {
    const reqCode = await runCommand(pythonCmd, ['-m', 'pip', 'install', '-r', ggufReqFile], out, { cwd: ggufNodeDir });
    if (reqCode !== 0) {
      vscode.window.showWarningMessage('ComfyUI-GGUF cloned, but its pip dependencies failed to install. Check the Output panel.');
      return false;
    }
  }

  vscode.window.showInformationMessage('ComfyUI-GGUF custom nodes installed. Restart the server to pick them up.');
  return true;
}

export async function installComfyUI(channel?: vscode.OutputChannel): Promise<boolean> {
  const out = channel ?? getOutputChannel();
  out.show(true);

  const installDir = getInstallDir();
  const parentDir = path.dirname(installDir);
  ensureDir(parentDir);

  const pythonCmd = getConfig().get<string>('pythonPath', 'python');

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Installing ComfyUI...', cancellable: false },
    async (progress) => {
      if (fs.existsSync(path.join(installDir, '.git'))) {
        out.appendLine(`ComfyUI already present at ${installDir}. Pulling latest changes...`);
        progress.report({ message: 'Updating existing install...' });
        const pullCode = await runCommand('git', ['pull'], out, { cwd: installDir });
        if (pullCode !== 0) {
          out.appendLine('git pull failed, continuing with existing checkout.');
        }
      } else {
        progress.report({ message: 'Cloning ComfyUI repository...' });
        const cloneCode = await runCommand('git', ['clone', COMFYUI_REPO, installDir], out);
        if (cloneCode !== 0) {
          vscode.window.showErrorMessage('Failed to clone ComfyUI. Check the Output panel for details.');
          return false;
        }
      }

      progress.report({ message: 'Installing Python dependencies (this can take a few minutes)...' });
      const reqFile = path.join(installDir, 'requirements.txt');
      const pipCode = await runCommand(
        pythonCmd,
        ['-m', 'pip', 'install', '-r', reqFile],
        out,
        { cwd: installDir }
      );

      if (pipCode !== 0) {
        vscode.window.showErrorMessage(
          'ComfyUI cloned, but pip install failed. Check the Output panel — you may need to install PyTorch manually for your GPU first.'
        );
        return false;
      }

      // The GGUF-quantized models we download need the ComfyUI-GGUF custom node pack
      // (UnetLoaderGGUF, CLIPLoaderGGUF) — without it, generation fails with
      // "Node 'UnetLoaderGGUF' not found".
      progress.report({ message: 'Installing ComfyUI-GGUF custom nodes...' });
      await installGGUFCustomNodes(out);

      // Create the custom folders we'll drop model files into.
      for (const sub of ['models/unet', 'models/text_encoders', 'models/vae']) {
        ensureDir(path.join(installDir, sub));
      }

      vscode.window.showInformationMessage(`ComfyUI installed at ${installDir}`);
      return true;
    }
  );
}
