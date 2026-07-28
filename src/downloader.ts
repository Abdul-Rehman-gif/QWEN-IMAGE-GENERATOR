import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { getInstallDir, getConfig, getOutputChannel } from './util';

interface FileSpec {
  repo: string;
  filename: string;
  destSubdir: string; // relative to ComfyUI root, e.g. 'models/unet'
}

const MAX_RETRIES = 6;
const RETRY_BASE_DELAY_MS = 3000;

/** Maps the quant setting to the checkpoint filename we expect in the GGUF repo. */
function quantFilename(quant: string): string {
  const map: Record<string, string> = {
    Q2_K: 'qwen-image-Q2_K.gguf',
    Q3_K_S: 'qwen-image-Q3_K_S.gguf',
    Q4_K_M: 'qwen-image-Q4_K_M.gguf',
    Q5_K_M: 'qwen-image-Q5_K_M.gguf',
    FP8: 'qwen-image-fp8.safetensors',
  };
  return map[quant] ?? map['Q4_K_M'];
}

function buildFileList(): FileSpec[] {
  const cfg = getConfig();
  const quant = cfg.get<string>('quantVariant', 'Q4_K_M');
  const ggufRepo = cfg.get<string>('hfRepoGGUF', 'unsloth/Qwen-Image-GGUF');
  const textEncoderRepo = cfg.get<string>('hfRepoTextEncoder', 'unsloth/Qwen2.5-VL-7B-Instruct-GGUF');
  const vaeRepo = cfg.get<string>('hfRepoVAE', 'Comfy-Org/Qwen-Image_ComfyUI');

  return [
    { repo: ggufRepo, filename: quantFilename(quant), destSubdir: 'models/unet' },
    { repo: textEncoderRepo, filename: 'Qwen2.5-VL-7B-Instruct-Q8_0.gguf', destSubdir: 'models/text_encoders' },
    { repo: textEncoderRepo, filename: 'mmproj-F16.gguf', destSubdir: 'models/text_encoders' },
    // This must be the ComfyUI-format VAE (matches UNet architecture), NOT the diffusers-format
    // VAE from Qwen/Qwen-Image — that one has a different conv kernel shape and fails to load
    // with a state_dict size mismatch. Verified against ComfyUI's own official example page.
    { repo: vaeRepo, filename: 'split_files/vae/qwen_image_vae.safetensors', destSubdir: 'models/vae' },
  ];
}

function hfUrl(repo: string, filename: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${filename}`;
}

const TEMP_SUFFIX = '.partial';

/**
 * Downloads a single attempt, resuming from any existing .partial file via
 * an HTTP Range request. Resolves with true if the file is now fully complete,
 * false if the server didn't honor the range and we had to restart from 0
 * (caller's existing partial bytes are discarded in that case).
 * Rejects on network error — caller is responsible for retrying.
 */
function downloadAttempt(
  url: string,
  tempPath: string,
  onProgress: (receivedMB: number, totalMB: number | null) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const existingBytes = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0;

    const doRequest = (targetUrl: string, redirectsLeft: number, rangeStart: number) => {
      const headers: Record<string, string> = { 'User-Agent': 'vscode-qwen-image-extension' };
      if (rangeStart > 0) {
        headers['Range'] = `bytes=${rangeStart}-`;
      }

      https
        .get(targetUrl, { headers }, (res) => {
          if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            if (redirectsLeft <= 0) {
              reject(new Error('Too many redirects'));
              return;
            }
            doRequest(res.headers.location, redirectsLeft - 1, rangeStart);
            return;
          }

          // Server supports resume and honored our Range request.
          const isResuming = res.statusCode === 206;
          // Server doesn't support ranges (200 despite our Range header) — must restart from scratch.
          const mustRestart = res.statusCode === 200 && rangeStart > 0;

          if (res.statusCode !== 200 && res.statusCode !== 206) {
            reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
            return;
          }

          let effectiveStart = rangeStart;
          if (mustRestart) {
            effectiveStart = 0;
            fs.rmSync(tempPath, { force: true });
          }

          const contentLength = parseInt(res.headers['content-length'] ?? '0', 10);
          const totalBytes = isResuming
            ? effectiveStart + contentLength
            : contentLength > 0
            ? contentLength
            : null;

          let received = effectiveStart;
          const fileStream = fs.createWriteStream(tempPath, { flags: effectiveStart > 0 ? 'a' : 'w' });

          res.on('data', (chunk) => {
            received += chunk.length;
            onProgress(received / (1024 * 1024), totalBytes !== null ? totalBytes / (1024 * 1024) : null);
          });

          res.pipe(fileStream);
          fileStream.on('finish', () =>
            fileStream.close(() => {
              // Guard against exactly what caused the corrupted-VAE bug: a connection that
              // drops mid-response can still fire 'finish' on the write stream even though
              // fewer bytes arrived than the server declared. Verify before accepting.
              if (totalBytes !== null && received < totalBytes) {
                reject(
                  new Error(
                    `Download ended early: got ${received} of ${totalBytes} expected bytes (connection likely dropped)`
                  )
                );
                return;
              }
              resolve();
            })
          );
          fileStream.on('error', reject);
          res.on('error', reject);
        })
        .on('error', reject);
    };

    doRequest(url, 5, existingBytes);
  });
}

/** Downloads with automatic retry + resume on transient network errors (ECONNRESET, ETIMEDOUT, DNS failures, etc). */
async function downloadWithRetry(
  url: string,
  destPath: string,
  out: vscode.OutputChannel,
  onProgress: (pct: number | null, receivedMB: number) => void
): Promise<void> {
  const tempPath = destPath + TEMP_SUFFIX;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await downloadAttempt(url, tempPath, (receivedMB, totalMB) => {
        const pct = totalMB ? Math.round((receivedMB / totalMB) * 100) : null;
        onProgress(pct, receivedMB);
      });
      // Success — promote the completed temp file to its final name.
      fs.renameSync(tempPath, destPath);
      return;
    } catch (err: any) {
      const isLastAttempt = attempt === MAX_RETRIES;
      const sizeNow = fs.existsSync(tempPath) ? (fs.statSync(tempPath).size / (1024 * 1024)).toFixed(0) : '0';
      out.appendLine(
        `\n  [network error on attempt ${attempt}/${MAX_RETRIES}] ${err.message} — ${sizeNow}MB saved so far.`
      );
      if (isLastAttempt) {
        throw err;
      }
      const delay = RETRY_BASE_DELAY_MS * attempt; // linear backoff: 3s, 6s, 9s, ...
      out.appendLine(`  Retrying in ${delay / 1000}s (will resume from ${sizeNow}MB, not restart)...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function downloadModels(channel?: vscode.OutputChannel): Promise<boolean> {
  const out = channel ?? getOutputChannel();
  out.show(true);

  const installDir = getInstallDir();
  if (!fs.existsSync(installDir)) {
    vscode.window.showErrorMessage('ComfyUI is not installed yet. Run "Qwen-Image: 1. Install ComfyUI" first.');
    return false;
  }

  const files = buildFileList();

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Downloading Qwen-Image model files', cancellable: false },
    async (progress) => {
      for (const f of files) {
        const destDir = path.join(installDir, f.destSubdir);
        fs.mkdirSync(destDir, { recursive: true });
        const destPath = path.join(destDir, path.basename(f.filename));

        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
          out.appendLine(`Skipping ${f.filename} — already downloaded at ${destPath}`);
          continue;
        }

        const url = hfUrl(f.repo, f.filename);
        out.appendLine(`\nDownloading ${f.filename} from ${f.repo} ...`);
        progress.report({ message: `Downloading ${path.basename(f.filename)}...` });

        try {
          let lastLogged = 0;
          await downloadWithRetry(url, destPath, out, (pct, mb) => {
            if (mb - lastLogged > 50 || pct === 100) {
              lastLogged = mb;
              out.appendLine(pct !== null ? `  ${pct}% (${mb.toFixed(0)} MB)` : `  ${mb.toFixed(0)} MB received`);
              progress.report({ message: `${path.basename(f.filename)}: ${pct !== null ? pct + '%' : mb.toFixed(0) + 'MB'}` });
            }
          });
          out.appendLine(`Saved to ${destPath}`);
        } catch (err: any) {
          out.appendLine(`\n[error] Failed to download ${f.filename} after ${MAX_RETRIES} attempts: ${err.message}`);
          vscode.window.showErrorMessage(
            `Failed to download ${f.filename} after several retries — your connection may be too unstable right now, or the file moved on Hugging Face. A partial download was kept at ${destPath}${TEMP_SUFFIX} and will resume next time you run this command.`
          );
          return false;
        }
      }

      vscode.window.showInformationMessage('All Qwen-Image model files downloaded.');
      return true;
    }
  );
}
