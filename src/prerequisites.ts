import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { getConfig, commandExists } from './util';

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown' | 'none';

export interface GpuInfo {
  vendor: GpuVendor;
  name: string;
  vramMB: number | null; // null if unknown
}

export interface PrereqResult {
  python: boolean;
  git: boolean;
  gpus: GpuInfo[];
}

function runAndCapture(cmd: string, args: string[], useShell = true): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    // useShell=false matters for powershell.exe -EncodedCommand: forcing it through
    // cmd.exe first can still interfere with how the encoded arg is passed on some builds.
    const child = spawn(cmd, args, { shell: useShell && process.platform === 'win32' });
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (out += d.toString()));
    child.on('error', (err) => resolve({ code: -1, out: `[spawn error] ${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

function classifyVendor(name: string): GpuVendor {
  const n = name.toLowerCase();
  if (n.includes('nvidia') || n.includes('geforce') || n.includes('rtx') || n.includes('quadro')) return 'nvidia';
  if (n.includes('amd') || n.includes('radeon') || n.includes('ati ')) return 'amd';
  if (n.includes('intel') || n.includes('iris') || n.includes('uhd graphics') || n.includes('arc ')) return 'intel';
  if (n.includes('apple m') || n.includes('apple silicon')) return 'apple';
  return 'unknown';
}

/** NVIDIA-specific: nvidia-smi gives us exact VRAM, so prefer this when available. */
async function detectNvidiaDetailed(): Promise<GpuInfo[]> {
  const result = await runAndCapture('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (result.code !== 0 || !result.out.trim()) return [];
  return result.out
    .trim()
    .split('\n')
    .map((line) => {
      const [name, mem] = line.split(',').map((s) => s.trim());
      const vram = parseInt(mem, 10);
      return { vendor: 'nvidia' as GpuVendor, name, vramMB: isNaN(vram) ? null : vram };
    });
}

let lastWindowsDetectDebug = '';

/**
 * Windows: works for any vendor (NVIDIA/AMD/Intel) via WMI.
 * Uses -EncodedCommand (base64 UTF-16LE) instead of -Command with inline quotes,
 * because spawning with shell:true routes through cmd.exe first, which mangles
 * nested double-quotes/pipes before PowerShell ever sees them.
 */
async function detectWindowsGeneric(): Promise<GpuInfo[]> {
  // $ProgressPreference suppresses the "#< CLIXML ... Preparing modules" progress-stream
  // noise that PowerShell otherwise interleaves with real output when invoked non-interactively.
  const script =
    "$ProgressPreference='SilentlyContinue'; Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  const result = await runAndCapture(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    false
  );

  lastWindowsDetectDebug = `exit=${result.code}\nstdout/stderr:\n${result.out}`;

  if (result.code !== 0 || !result.out.trim()) return [];

  // Even with ProgressPreference silenced, be defensive: pull out just the JSON
  // object/array in case anything else gets mixed into the stream.
  const match = result.out.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) {
    lastWindowsDetectDebug += '\n[no JSON found in output]';
    return [];
  }

  try {
    const parsed = JSON.parse(match[0]);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((g: any) => g && g.Name)
      .map((g: any) => {
        const vramBytes = typeof g.AdapterRAM === 'number' ? g.AdapterRAM : null;
        // AdapterRAM on Windows is a 32-bit field and frequently wraps/reports wrong for >4GB cards — treat as approximate only.
        const vramMB = vramBytes && vramBytes > 0 ? Math.round(vramBytes / (1024 * 1024)) : null;
        return { vendor: classifyVendor(g.Name), name: g.Name as string, vramMB };
      });
  } catch (e: any) {
    lastWindowsDetectDebug += `\n[JSON parse error] ${e.message}`;
    return [];
  }
}

export function getLastWindowsDetectDebug(): string {
  return lastWindowsDetectDebug;
}

/** Linux: lspci lists all GPUs across vendors, but not VRAM size. */
async function detectLinuxGeneric(): Promise<GpuInfo[]> {
  const result = await runAndCapture('bash', ['-c', "lspci | grep -Ei 'vga|3d|display'"]);
  if (result.code !== 0 || !result.out.trim()) return [];
  return result.out
    .trim()
    .split('\n')
    .map((line) => {
      const name = line.split(':').slice(2).join(':').trim() || line.trim();
      return { vendor: classifyVendor(name), name, vramMB: null };
    });
}

/** macOS: system_profiler covers Apple Silicon and any discrete/integrated GPU. */
async function detectMacGeneric(): Promise<GpuInfo[]> {
  const result = await runAndCapture('system_profiler', ['SPDisplaysDataType']);
  if (result.code !== 0 || !result.out.trim()) return [];
  const chipsetMatches = [...result.out.matchAll(/Chipset Model:\s*(.+)/g)];
  const vramMatches = [...result.out.matchAll(/VRAM \(.*?\):\s*(\d+)\s*(MB|GB)/g)];
  return chipsetMatches.map((m, i) => {
    const name = m[1].trim();
    let vramMB: number | null = null;
    if (vramMatches[i]) {
      const val = parseInt(vramMatches[i][1], 10);
      vramMB = vramMatches[i][2] === 'GB' ? val * 1024 : val;
    }
    return { vendor: classifyVendor(name), name, vramMB };
  });
}

export async function detectGpus(): Promise<GpuInfo[]> {
  const platform = process.platform;
  let gpus: GpuInfo[] = [];

  if (platform === 'win32') {
    gpus = await detectWindowsGeneric();
  } else if (platform === 'darwin') {
    gpus = await detectMacGeneric();
  } else {
    gpus = await detectLinuxGeneric();
  }

  // Cross-check with nvidia-smi for accurate VRAM if there's an NVIDIA card in the mix
  // (WMI/lspci VRAM numbers for NVIDIA are often wrong or missing).
  const hasNvidia = gpus.some((g) => g.vendor === 'nvidia');
  if (hasNvidia || gpus.length === 0) {
    const nvDetailed = await detectNvidiaDetailed();
    if (nvDetailed.length > 0) {
      gpus = gpus.filter((g) => g.vendor !== 'nvidia').concat(nvDetailed);
    }
  }

  return gpus;
}

export async function checkPrerequisites(): Promise<PrereqResult> {
  const pythonCmd = getConfig().get<string>('pythonPath', 'python');

  const [pythonOk, gitOk, gpus] = await Promise.all([
    commandExists(pythonCmd),
    commandExists('git'),
    detectGpus(),
  ]);

  return { python: pythonOk, git: gitOk, gpus };
}

function formatGpuLine(g: GpuInfo): string {
  const vramStr = g.vramMB ? `${(g.vramMB / 1024).toFixed(1)}GB VRAM` : 'VRAM unknown';
  const vendorLabel = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple Silicon', unknown: 'Unknown vendor', none: '' }[
    g.vendor
  ];
  return `  • ${g.name} (${vendorLabel}, ${vramStr})`;
}

function guidanceFor(gpus: GpuInfo[]): string {
  if (gpus.length === 0) {
    return 'No GPU detected at all — you will run on CPU only. This works but is slow (minutes per image). Set Quant Variant to Q2_K in settings.';
  }

  const nvidia = gpus.find((g) => g.vendor === 'nvidia');
  const amd = gpus.find((g) => g.vendor === 'amd');
  const apple = gpus.find((g) => g.vendor === 'apple');
  const intelOnly = gpus.every((g) => g.vendor === 'intel');

  if (nvidia) {
    const vram = nvidia.vramMB ? nvidia.vramMB / 1024 : null;
    if (vram && vram >= 16) return 'NVIDIA GPU with 16GB+ VRAM — you can use FP8 or Q5_K_M for best quality.';
    if (vram && vram >= 12) return 'NVIDIA GPU with 12-16GB VRAM — Q4_K_M is a good balance of speed/quality.';
    if (vram && vram >= 8) return 'NVIDIA GPU with 8-12GB VRAM — use Q3_K_S or Q4_K_M.';
    return 'NVIDIA GPU detected (VRAM size unclear) — start with Q3_K_S and increase if generation is fast/stable.';
  }
  if (amd) {
    return "AMD GPU detected. ComfyUI runs on AMD via ROCm (Linux) or DirectML (Windows), but setup is more involved than NVIDIA/CUDA and generation is typically slower. CPU fallback (Q2_K) is the simpler path if you hit driver issues.";
  }
  if (apple) {
    return "Apple Silicon detected. ComfyUI supports Apple's MPS backend — reasonable speed for a laptop. Use Q3_K_S or Q4_K_M depending on unified memory size.";
  }
  if (intelOnly) {
    return 'Only Intel integrated graphics detected — treat this as CPU-class performance. Use Q2_K and expect slow generation.';
  }
  return 'GPU detected but vendor/capability unclear — treat conservatively and start with Q2_K/Q3_K_S.';
}

export async function checkPrerequisitesCommand() {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking system requirements...' },
    () => checkPrerequisites()
  );

  const channel = vscode.window.createOutputChannel('Qwen-Image Local');
  channel.show(true);
  channel.appendLine('=== Qwen-Image Prerequisite Check ===');
  channel.appendLine(`Python: ${result.python ? '✅ found' : '❌ not found — install Python 3.10/3.11 from python.org'}`);
  channel.appendLine(`Git: ${result.git ? '✅ found' : '❌ not found — install from git-scm.com'}`);

  if (result.gpus.length === 0) {
    channel.appendLine('GPU: ⚠️ none detected');
    if (process.platform === 'win32') {
      channel.appendLine('\n--- Windows GPU detection debug output ---');
      channel.appendLine(getLastWindowsDetectDebug() || '(detection command did not run)');
      channel.appendLine('--- end debug output ---');
    }
  } else {
    channel.appendLine('GPU(s) found:');
    result.gpus.forEach((g) => channel.appendLine(formatGpuLine(g)));
  }

  const guidance = guidanceFor(result.gpus);
  channel.appendLine(`\nGuidance: ${guidance}`);

  if (result.python && result.git) {
    vscode.window.showInformationMessage(`Prerequisites checked. ${guidance}`);
  } else {
    vscode.window.showWarningMessage('Missing prerequisites (Python and/or Git). See Output panel for details.');
  }
}
