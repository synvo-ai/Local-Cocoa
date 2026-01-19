<div align="center">
<img src="assets/banner/banner.png" alt="Local Cocoa Banner" width="100%">

# 🍫 Local Cocoa: Your Personal AI Assistant, Fully Local 💻

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)]()
[![Windows](https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white)]()
[![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)]()
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20Local-success.svg)]()
[![Powered by](https://img.shields.io/badge/Powered%20by-llama.cpp-blueviolet.svg)](https://github.com/ggerganov/llama.cpp)
[![i18n](https://img.shields.io/badge/i18n-8%20Languages-blue.svg)](./INTERNATIONALIZATION.md)

</div>

---

💻 Local Cocoa runs entirely on your device, not inside the cloud.

🧠 Each file turns into memory. Memories form context.
Context sparks insight. Insight powers action.

🔒 No externals eyes. No data leaving. Just your computer learning you better, helping you smarter.

### 🎬 Live Demos

<div align="center">

|                                                     🔍 **File Retrieval**                                                     |                                                   📊 **Year-End Report**                                                    |                                                    ⌨️ **Global Shortcuts**                                                    |
| :--------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------: |
| <a href="https://vimeo.com/1151769782"><img src="https://vumbnail.com/1151769782.jpg" width="100%" alt="Retrieval Demo"></a> | <a href="#"><img src="https://placehold.co/600x400/202020/FFFFFF/png?text=Coming+Soon" width="100%" alt="Report Demo"></a> | <a href="#"><img src="https://placehold.co/600x400/202020/FFFFFF/png?text=Coming+Soon" width="100%" alt="Shortcut Demo"></a> |
|                                            *Instantly chat with your local files*                                            |                                               *Scan 2025 files for insights*                                               |                                                   *Access Synvo anywhere*                                                    |

</div>



## 🛠️ Quick Start

Local Cocoa uses a modern **Electron + React + Python FastAPI** hybrid architecture.

### 🚀 Prerequisites

Ensure the following are installed on your system:

- **Node.js** v18.17 or higher
- **Python** v3.10 or higher
- **CMake** (for building the `llama.cpp` server)

### Step 1: Clone the Repository

```bash
git clone https://github.com/synvo-ai/local-cocoa.git
cd local-cocoa
```

### Step 2: Install Dependencies

```bash
# Frontend / Electron
npm install

# Backend / RAG Agent (macOS/Linux)
python3 -m venv .venv
source .venv/bin/activate
pip install -r services/app/requirements.txt

# Backend / RAG Agent (Windows PowerShell)
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r services/app/requirements.txt
```

### Step 3: Download Local Models

We provide a script to automatically download embedding, reranker, and vision models:

```bash
npm run models:download
```

<details>
<summary><strong>Proxy Support (Clash / Shadowsocks / Corporate)</strong></summary>

Model downloads support:

- **System proxy** (recommended): If Clash/Shadowsocks is set as your OS proxy, downloads will use it automatically.
- **Environment variables**: Set one of these (case-insensitive):
  - `HTTPS_PROXY` / `HTTP_PROXY` (e.g., `http://127.0.0.1:7890`)
  - `ALL_PROXY` (supports `socks5://...`)
  - `NO_PROXY` (comma-separated bypass list, e.g., `localhost,127.0.0.1`)

Windows PowerShell example:

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npm run models:download
```

</details>

### Step 4: Build Llama Server

> **Windows Users**: If you have pre-compiled binaries, place `llama-server.exe` in `runtime/llama-cpp/bin/`.

Build `llama-server` using CMake:

```bash
mkdir -p runtime && cd runtime
git clone https://github.com/ggerganov/llama.cpp.git llama-cpp
cd llama-cpp
mkdir -p build && cd build
cmake .. -DLLAMA_BUILD_SERVER=ON
cmake --build . --target llama-server --config Release
cd ..

# Organize binaries (macOS/Linux)
mkdir -p bin
cp build/bin/llama-server bin/llama-server

# Windows: cp build/bin/Release/llama-server.exe bin/llama-server.exe

cd ../..
```

### Step 5: Build Whisper Server (Speech-to-Text)

To enable transcriptions:

```bash
# In runtime folder
cd runtime
git clone https://github.com/ggml-org/whisper.cpp.git whisper-cpp
cd whisper-cpp
cmake -B build
cmake --build build -j --config Release
mv build/bin ./
# The app expects the binary at runtime/whisper-cpp/bin/whisper-server
# For Windows, check build/bin/Release/whisper-server.exe
cd ../..
```

### 🏃 Run in Development Mode

Ensure your Python virtual environment is active, then run:

```bash
# macOS/Linux
source .venv/bin/activate
npm run dev

# Windows PowerShell
.venv\Scripts\Activate.ps1
npm run dev
```

This launches the **React Dev Server**, **Electron client**, and **FastAPI backend** simultaneously.

---

## Key Features (Keep Updating)

### 🛡️ Privacy First

- **🔐 Fully Local Privacy**: All inference, indexing, and retrieval run entirely on your device with zero data leaving.
  - *💡 **Pro Tip**: If you verify network activity using tools like **Little Snitch** (macOS) or **GlassWire** (Windows), you'll confirm that no personal data leaves your device.

### 🧠 Core Intelligence

- **🧠 Multimodal Memory**: Turns documents, images, audio, and video into a persistent semantic memory space.
- **🔍 Vector-Powered Retrieval**: Local Qdrant search with semantic reranking for precise, high-recall answers.
- **📁 Intelligent Indexing**: Smartly monitors folders to incrementally index, chunk, and embed efficient vectors.
- **🖼 Vision Understanding**: Integrated OCR and VLM to extract text and meaning from screenshots and PDFs.

### ⚡ Performance & Experience

- **⚡ Hardware Accelerated**: Optimized `llama.cpp` engine designed for Apple Silicon and consumer GPUs.
- **🍫 Focused UX**: A calm, responsive interface designed for clarity and seamless interaction.
- **✍ Integrated Notes**: Write notes that become part of your semantic memory for future recall.
- **🔁 Auto-Sync**: Automatically detects file changes and keeps your knowledge base fresh.


---

## 🏗️ Architecture Overview

Local Cocoa runs entirely on your device. It combines file ingestion, intelligent chunking, and local retrieval to build a private on-device knowledge system.

<div align="center">
  <img src="assets/architecture/architecture.png" width="800" alt="Local Cocoa Architecture Diagram">
</div>

**Frontend**: Electron • React • TypeScript • TailwindCSS  
**Backend**: FastAPI • llama.cpp • Qdrant





## 🎯 The Ultimate Goal of Local Cocoa
<div align="center">
  <img src="assets/vision/vision.png" width="800" alt="Local Cocoa Vision Diagram">
</div>
We're actively developing these features—contributions welcome!

- [ ] **👑 More Connectors**: Google Drive, Notion, Slack integration
- [ ] **🎤 Voice Mode**: Local speech-to-text for voice interaction
- [ ] **🔌 Plugin Ecosystem**: Open API for community tools and agents

## ✨ Contributors

### 💡 Core Contributors

<a href="https://github.com/EricFan2002">
  <img src="https://github.com/EricFan2002.png?size=100" width="50px" alt="EricFan2002" />
</a>
<a href="https://github.com/Jingkang50">
  <img src="https://github.com/Jingkang50.png?size=100" width="50px" alt="Jingkang50" />
</a>
<a href="https://github.com/Tom-TaoQin">
  <img src="https://github.com/Tom-TaoQin.png?size=100" width="50px" alt="Tom-TaoQin" />
</a>
<a href="https://github.com/choiszt">
  <img src="https://github.com/choiszt.png?size=100" width="50px" alt="choiszt" />
</a>
<a href="https://github.com/KairuiHu">
  <img src="https://github.com/KairuiHu.png?size=100" width="50px" alt="KairuiHu" />
</a>

<!-- ### 🌍 Community Contributors

<a href="https://github.com/synvo-ai/local-cocoa/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=synvo-ai/local-cocoa" />
</a> -->

## 🌍 Internationalization

Local Cocoa supports **8 languages** out of the box:

🇬🇧 English • 🇨🇳 简体中文 • 🇯🇵 日本語 • 🇰🇷 한국어 • 🇫🇷 Français • 🇩🇪 Deutsch • 🇪🇸 Español • 🇷🇺 Русский

**Quick Start**: [INTERNATIONALIZATION.md](./INTERNATIONALIZATION.md)  
**Full Documentation**: [docs/i18n/](./docs/i18n/)

## 🤝 Contributing

We welcome contributions of all kinds—bug fixes, features, or documentation improvements.

**Please read our [Contribution Guidelines](CONTRIBUTING.md) before submitting a Pull Request or Issue.**

### Quick Guide

1.  Fork the repository
2.  Create your feature branch (`git checkout -b feature/amazing-feature`)
3.  Make your changes
4.  Commit your changes (`git commit -m 'feat: add amazing feature'`)
    - 🔍 **Pre-commit hooks** will automatically check your code for errors
    - Run `npm run lint:fix` to auto-fix common issues
5.  Push to the branch (`git push origin feature/amazing-feature`)
6.  Open a Pull Request

### Code Quality

This project enforces code quality through automated pre-commit hooks:

- ✅ **ESLint** checks for unused imports/variables and coding standards
- ✅ **TypeScript** ensures type safety
- ✅ Commits are blocked if errors are found

See [CONTRIBUTING.md](CONTRIBUTING.md#code-quality) for details.

Thank you to everyone who has contributed to Local Cocoa! 🙏

## 📄 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
