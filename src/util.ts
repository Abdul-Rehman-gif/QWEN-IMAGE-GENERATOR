import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, SpawnOptionsWithoutStdio } from 'child_process';

export function getConfig() {
  return vscode.workspace.getConfiguration('qwenImage');
}

export function getInstallDir(): string {
  const configured = getConfig().get<string>('installDir', '').trim();
  if (configured) {
    return configured;
  }
  return path.join(os.homedir(), 'qwen-image-local', 'ComfyUI');
}

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Runs a command, streaming stdout/stderr into the given output channel.
 * Resolves with exit code. Rejects on spawn error (e.g. binary not found).
 */
export function runCommand(
  cmd: string,
  args: string[],
  channel: vscode.OutputChannel,
  options: SpawnOptionsWithoutStdio = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    channel.appendLine(`\n$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { shell: process.platform === 'win32', ...options });

    child.stdout?.on('data', (data) => channel.append(data.toString()));
    child.stderr?.on('data', (data) => channel.append(data.toString()));

    child.on('error', (err) => {
      channel.appendLine(`\n[error] Failed to start "${cmd}": ${err.message}`);
      reject(err);
    });

    child.on('close', (code) => {
      channel.appendLine(`\n[exit code ${code}] ${cmd}`);
      resolve(code ?? -1);
    });
  });
}

/** Quick check for whether a binary exists on PATH by attempting to run "<cmd> --version". */
export async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--version'], { shell: process.platform === 'win32' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 || code === null ? true : code === 0));
  });
}

export function getOutputChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel('Qwen-Image Local');
}
