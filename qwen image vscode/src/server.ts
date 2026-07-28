import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { getInstallDir, getConfig, getOutputChannel } from './util';
import { detectGpus } from './prerequisites';

let serverProcess: ChildProcessWithoutNullStreams | null = null;
let serverChannel: vscode.OutputChannel | null = null;

export function isServerRunning(): boolean {
  return serverProcess !== null && !serverProcess.killed;
}

export function getServerUrl(): string {
  const cfg = getConfig();
  const host = cfg.get<string>('serverHost', '127.0.0.1');
  const port = cfg.get<number>('serverPort', 8188);
  return `http://${host}:${port}`;
}

export async function launchServer(): Promise<boolean> {
  if (isServerRunning()) {
    vscode.window.showInformationMessage(`ComfyUI is already running at ${getServerUrl()}`);
    return true;
  }

  const installDir = getInstallDir();
  const pythonCmd = getConfig().get<string>('pythonPath', 'python');
  const host = getConfig().get<string>('serverHost', '127.0.0.1');
  const port = getConfig().get<number>('serverPort', 8188);

  serverChannel = serverChannel ?? vscode.window.createOutputChannel('Qwen-Image Server');
  serverChannel.show(true);
  serverChannel.appendLine(`Starting ComfyUI from ${installDir} ...`);

  // ComfyUI defaults to assuming an NVIDIA/CUDA GPU is present and crashes
  // (AssertionError: Torch not compiled with CUDA enabled) if it isn't and
  // --cpu wasn't passed. Detect once here and pass it automatically when needed.
  const gpus = await detectGpus();
  const hasNvidia = gpus.some((g) => g.vendor === 'nvidia');
  const args = ['main.py', '--listen', host, '--port', String(port)];
  if (!hasNvidia) {
    args.push('--cpu');
    serverChannel.appendLine('No NVIDIA GPU detected — launching ComfyUI in CPU mode (--cpu).');
  }

  return new Promise((resolve) => {
    serverProcess = spawn(pythonCmd, args, { cwd: installDir, shell: process.platform === 'win32' });

    let resolved = false;

    serverProcess.stdout.on('data', (data) => {
      const text = data.toString();
      serverChannel?.append(text);
      if (!resolved && text.toLowerCase().includes('to see the gui go to')) {
        resolved = true;
        vscode.window.showInformationMessage(`ComfyUI server running at ${getServerUrl()}`);
        resolve(true);
      }
    });

    serverProcess.stderr.on('data', (data) => serverChannel?.append(data.toString()));

    serverProcess.on('error', (err) => {
      serverChannel?.appendLine(`\n[error] ${err.message}`);
      vscode.window.showErrorMessage(`Failed to launch ComfyUI: ${err.message}`);
      serverProcess = null;
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });

    serverProcess.on('close', (code) => {
      serverChannel?.appendLine(`\nComfyUI process exited with code ${code}`);
      serverProcess = null;
    });

    // Fallback: if we don't see the expected log line within 60s, assume it's up anyway
    // (log format can vary between ComfyUI versions) and let the user try generating.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(true);
      }
    }, 60000);
  });
}

export function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
    vscode.window.showInformationMessage('ComfyUI server stopped.');
  } else {
    vscode.window.showInformationMessage('ComfyUI server was not running.');
  }
}
