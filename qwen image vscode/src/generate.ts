import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { getConfig, getOutputChannel } from './util';
import { getServerUrl, isServerRunning } from './server';

function httpPostJson(url: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Bad JSON response: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Bad JSON response: ${raw.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });
}

function downloadToBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

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

export async function generateImage(context: vscode.ExtensionContext) {
  if (!isServerRunning()) {
    const choice = await vscode.window.showWarningMessage(
      'ComfyUI server is not running. Start it first?',
      'Start Server',
      'Cancel'
    );
    if (choice !== 'Start Server') {
      return;
    }
    await vscode.commands.executeCommand('qwenImage.launchServer');
    // Give it a moment to come up.
    await new Promise((r) => setTimeout(r, 3000));
  }

  const prompt = await vscode.window.showInputBox({
    prompt: 'Describe the image you want Qwen-Image to generate',
    placeHolder: 'e.g. a red panda reading a book under a maple tree, watercolor style',
  });
  if (!prompt) {
    return;
  }

  const cfg = getConfig();
  const quant = cfg.get<string>('quantVariant', 'Q4_K_M');
  const out = getOutputChannel();
  out.show(true);

  const templatePath = path.join(context.extensionPath, 'resources', 'workflow_api.json');
  let workflowText = fs.readFileSync(templatePath, 'utf-8');

  const seed = Math.floor(Math.random() * 1_000_000_000);
  workflowText = workflowText
    .replace('%UNET_FILENAME%', quantFilename(quant))
    .replace('%CLIP_FILENAME%', 'Qwen2.5-VL-7B-Instruct-Q8_0.gguf')
    .replace('%VAE_FILENAME%', 'qwen_image_vae.safetensors')
    .replace('%PROMPT%', prompt.replace(/"/g, '\\"'))
    .replace('%NEGATIVE_PROMPT%', 'blurry, low quality, distorted')
    .replace('%WIDTH%', '1024')
    .replace('%HEIGHT%', '1024')
    .replace('%SEED%', String(seed))
    .replace('%STEPS%', '20')
    .replace('%CFG%', '4.0');

  const workflow = JSON.parse(workflowText);
  const serverUrl = getServerUrl();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Generating image with Qwen-Image...', cancellable: false },
    async (progress) => {
      try {
        progress.report({ message: 'Submitting prompt to ComfyUI...' });
        const queueResp = await httpPostJson(`${serverUrl}/prompt`, { prompt: workflow });

        if (queueResp.error) {
          out.appendLine(`\n[error] ComfyUI rejected the workflow: ${JSON.stringify(queueResp.error)}`);
          vscode.window.showErrorMessage(
            'ComfyUI rejected the workflow — this usually means node names or model filenames don\'t match your ComfyUI/GGUF plugin version. See Output panel.'
          );
          return;
        }

        const promptId = queueResp.prompt_id;
        out.appendLine(`Queued as prompt_id=${promptId}. Waiting for result...`);

        progress.report({ message: 'Rendering (CPU generation can take a long time — this may run for 10-40+ minutes)...' });

        const POLL_INTERVAL_MS = 3000;
        const MAX_WAIT_MINUTES = 60;
        const maxIterations = Math.ceil((MAX_WAIT_MINUTES * 60 * 1000) / POLL_INTERVAL_MS);

        let imageInfo: any = null;
        let executionError: any = null;

        for (let i = 0; i < maxIterations; i++) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

          const elapsedMin = Math.round(((i + 1) * POLL_INTERVAL_MS) / 60000);
          progress.report({ message: `Rendering on CPU... ${elapsedMin} min elapsed (this can take 10-40+ min)` });

          const history = await httpGetJson(`${serverUrl}/history/${promptId}`);
          const entry = history[promptId];

          if (entry?.status?.status_str === 'error') {
            executionError = entry.status.messages ?? entry.status;
            break;
          }

          if (entry && entry.outputs) {
            for (const nodeId of Object.keys(entry.outputs)) {
              const images = entry.outputs[nodeId].images;
              if (images && images.length > 0) {
                imageInfo = images[0];
                break;
              }
            }
          }
          if (imageInfo) {
            break;
          }

          // Log a periodic heartbeat to the Output channel so it's visible outside the notification too.
          if ((i + 1) % 10 === 0) {
            out.appendLine(`  still rendering... ${elapsedMin} min elapsed`);
          }
        }

        if (executionError) {
          out.appendLine(`\n[error] ComfyUI reported an execution error: ${JSON.stringify(executionError)}`);
          vscode.window.showErrorMessage('ComfyUI hit an error while rendering — see Output panel for details.');
          return;
        }

        if (!imageInfo) {
          out.appendLine(
            `\n[timeout] No result after ${MAX_WAIT_MINUTES} minutes. The job may still be running in ComfyUI — check the Qwen-Image Server output, or try http://127.0.0.1:8188 directly in a browser to see the queue.`
          );
          vscode.window.showErrorMessage(
            `Still no image after ${MAX_WAIT_MINUTES} minutes. It may still be processing — check the Qwen-Image Server output, or open http://127.0.0.1:8188 in a browser to check the queue directly.`
          );
          return;
        }

        const imgUrl = `${serverUrl}/view?filename=${encodeURIComponent(imageInfo.filename)}&subfolder=${encodeURIComponent(
          imageInfo.subfolder ?? ''
        )}&type=${encodeURIComponent(imageInfo.type ?? 'output')}`;

        const buffer = await downloadToBuffer(imgUrl);
        const savePath = path.join(context.globalStorageUri.fsPath, imageInfo.filename);
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, buffer);

        out.appendLine(`Saved generated image to ${savePath}`);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(savePath));
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(savePath));
        vscode.window.showInformationMessage(`Image generated: ${savePath}`);
      } catch (err: any) {
        out.appendLine(`\n[error] ${err.message}`);
        vscode.window.showErrorMessage(`Generation failed: ${err.message}`);
      }
    }
  );
}
