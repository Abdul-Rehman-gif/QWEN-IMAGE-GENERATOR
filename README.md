<div align="center">
  <img src="qwen image vscode/images/banner.png" alt="Qwen-Image Local Runner" width="100%">

  # 🎨 Qwen-Image Local Runner

  **Generate AI images locally, straight from VS Code — no cloud API, no manual terminal juggling.**

  This extension installs [ComfyUI](https://github.com/comfyanonymous/ComfyUI), downloads the open-source
  [Qwen-Image](https://huggingface.co/Qwen) model, and wires it all together so you can go from "nothing installed"
  to "generating images" using only the Command Palette.

  [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#-requirements)
  [![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC?logo=visualstudiocode&logoColor=white)](#-installation)
  [![GPU](https://img.shields.io/badge/GPU-NVIDIA%20%7C%20AMD%20%7C%20Apple%20%7C%20CPU-orange)](#-hardware-guidance)

</div>

---

## ✨ Features

- 🧩 **One-click setup** — clones ComfyUI, installs its Python dependencies, installs the GGUF custom node pack, and downloads all model files automatically
- 🖥️ **Cross-vendor GPU detection** — recognizes NVIDIA, AMD, Intel, and Apple Silicon, and tunes its recommendations (and launch flags) accordingly
- 🐌➡️⚡ **Automatic CPU fallback** — if there's no NVIDIA GPU, the server launches in `--cpu` mode automatically, no flags to remember
- 📶 **Resilient downloads** — resumes from where it left off after a dropped connection instead of restarting multi-GB files from zero, and verifies every file is fully intact before accepting it
- 💬 **Prompt-to-image, no node graph required** — type a prompt in a VS Code input box; the extension builds and submits the ComfyUI workflow for you
- 🔧 **Self-healing commands** — dedicated commands to fix custom nodes or restart the server without redoing the whole install

---

## 📸 Screenshots

> The banner above is a stylized graphic, not a literal screenshot — real screenshots go here as the project gets used. In the meantime, here's the shape of the experience:

**Prompt input (Command Palette → `Qwen-Image: Generate Image`):**
```
a red panda reading a book under a maple tree, watercolor style
```

**Result:** the generated PNG opens automatically inside VS Code once rendering finishes.

---

## 🚀 Installation

Not published to the Marketplace — install directly from the `.vsix` file:

```bash
code --install-extension qwen-image-local-X.Y.Z.vsix
```

Or in VS Code: `Ctrl+Shift+P` → **`Extensions: Install from VSIX...`** → select the file → click **Restart Extensions** when prompted.

---

## ⚙️ Requirements

| Requirement | Notes |
|---|---|
| **Python 3.10 / 3.11** | On PATH. Very new Python versions (e.g. 3.14) can work but are more likely to hit PyTorch compatibility issues first. |
| **Git** | On PATH — used to clone ComfyUI and the GGUF custom nodes. |
| **Disk space** | ~15–20GB free, depending on which quantization you choose. |
| **GPU (optional)** | NVIDIA with 8GB+ VRAM gives the best speed. AMD, Apple Silicon, and CPU-only all work, just slower — see below. |

### 🖥 Hardware guidance

| Your hardware | What to expect | Recommended `quantVariant` |
|---|---|---|
| NVIDIA, 16GB+ VRAM | Seconds per image | `FP8` or `Q5_K_M` |
| NVIDIA, 8–16GB VRAM | Tens of seconds | `Q3_K_S` – `Q4_K_M` |
| AMD GPU | Works via ROCm/DirectML, more setup, slower than NVIDIA | `Q3_K_S` |
| Apple Silicon | Reasonable speed via MPS | `Q3_K_S` – `Q4_K_M` |
| CPU only (no dedicated GPU) | **Minutes per image** — this is normal, not a bug | `Q2_K` |

---

## 🛠 Usage

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run, in order:

| Step | Command |
|---|---|
| 1 | **`Qwen-Image: Check System Requirements`** — confirms Python, Git, and detects your GPU |
| 2 | **`Qwen-Image: Run Full Setup (Install + Download + Launch)`** — does everything below in one go |
| 3 | **`Qwen-Image: Generate Image`** — type a prompt, get an image back |

Or run the individual stages separately if you want more control:

- **`Qwen-Image: 1. Install ComfyUI`**
- **`Qwen-Image: 2. Download Model Files`**
- **`Qwen-Image: 3. Start Server`** / **`Qwen-Image: Stop Server`**
- **`Qwen-Image: Fix/Reinstall GGUF Custom Nodes`** — repairs the loader nodes without a full reinstall

---

## ⚙️ Extension Settings

Search **"Qwen Image"** in VS Code Settings (`Ctrl+,`):

| Setting | Description | Default |
|---|---|---|
| `qwenImage.installDir` | Where ComfyUI gets installed | `~/qwen-image-local/ComfyUI` |
| `qwenImage.pythonPath` | Command used to invoke Python | `python` |
| `qwenImage.quantVariant` | Model quantization — smaller = faster, lower quality | `Q4_K_M` |
| `qwenImage.hfRepoGGUF` | Hugging Face repo for the GGUF checkpoint | `unsloth/Qwen-Image-GGUF` |
| `qwenImage.hfRepoTextEncoder` | Hugging Face repo for the text encoder + mmproj | `unsloth/Qwen2.5-VL-7B-Instruct-GGUF` |
| `qwenImage.hfRepoVAE` | Hugging Face repo for the VAE | `Comfy-Org/Qwen-Image_ComfyUI` |
| `qwenImage.serverHost` / `serverPort` | Where ComfyUI binds | `127.0.0.1` / `8188` |

---

## 🩺 Troubleshooting

Real issues hit during development, and their fixes:

<details>
<summary><strong>"Node 'UnetLoaderGGUF' not found"</strong></summary>

The [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) custom node pack isn't installed. Run
**`Qwen-Image: Fix/Reinstall GGUF Custom Nodes`**, then **fully stop and restart** the server
(`Qwen-Image: Stop Server` → `Qwen-Image: 3. Start Server`) — ComfyUI only scans for custom nodes at startup.
</details>

<details>
<summary><strong>"Torch not compiled with CUDA enabled"</strong></summary>

Happens on non-NVIDIA machines. Fixed automatically since v0.6.0 — the server detects your GPU vendor and
adds `--cpu` when there's no NVIDIA card. If you still see this, make sure you're on the latest version.
</details>

<details>
<summary><strong>"Port 8188 is already in use"</strong></summary>

A previous ComfyUI process is still running in the background (common after reloading the VS Code window
mid-session, which disconnects the extension's tracking without killing the process). Fix:

```powershell
# Windows
taskkill /F /IM python.exe
```
```bash
# macOS/Linux
pkill -f "main.py --listen"
```
Then start the server fresh.
</details>

<details>
<summary><strong>Downloads keep failing partway through</strong></summary>

Since v0.5.0, downloads resume from where they dropped instead of restarting, and retry automatically up to
6 times. If a file still fails repeatedly, check your connection stability first — large model files (multi-GB)
need a sustained connection, and intermittent Wi-Fi is the most common cause.
</details>

<details>
<summary><strong>"size mismatch" / "incomplete metadata" errors when loading the VAE</strong></summary>

This means the VAE file doesn't match the model's expected architecture (or is corrupted). Delete the file
and redownload:
```powershell
del "<installDir>\models\vae\qwen_image_vae.safetensors"
```
then run **`Qwen-Image: 2. Download Model Files`** again.
</details>

<details>
<summary><strong>Generation seems stuck / very slow</strong></summary>

On CPU-only hardware, 10–40+ minutes per image is normal, not a bug. Check the **"Qwen-Image Server"** Output
channel for sampling progress logs — if numbers are ticking up, it's working. If your system has limited RAM,
it may also be swapping to disk, which slows things further; lowering resolution/steps helps.
</details>

---

## 📂 Project Structure

```
qwen-image-vscode
├── src/
│   ├── extension.ts       # command registration
│   ├── prerequisites.ts   # cross-vendor GPU + Python/Git detection
│   ├── installer.ts       # ComfyUI + GGUF custom node install
│   ├── downloader.ts      # resumable, verified model downloads
│   ├── server.ts          # launch/stop the ComfyUI process
│   ├── generate.ts        # prompt → workflow → image
│   └── util.ts            # shared helpers
├── resources/
│   └── workflow_api.json  # ComfyUI API-format workflow template
├── images/
│   └── banner.svg
├── package.json
└── README.md
```

---

## 🤝 Contributing

Issues and improvements welcome — this started as a personal setup tool and grew from real debugging sessions,
so PRs that harden the rough edges (better error messages, more GPU backends, workflow presets) are especially useful.

## 📄 License

MIT — see [LICENSE](LICENSE).

## ❤️ Acknowledgements

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) by comfyanonymous
- [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) by city96
- [Qwen-Image GGUF quantizations](https://huggingface.co/unsloth) by Unsloth
- The [Qwen team](https://huggingface.co/Qwen) for the underlying model
