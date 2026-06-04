<p align="center">
  <img src="assets/gabie-smile.png" alt="Gabie" width="180" />
</p>

<h1 align="center">Gabie</h1>

<p align="center">
  <strong>Your personal AI assistant.</strong><br/>
  An ultra-lightweight agent tool powered by a local LLM. Invokes Tools and Skills to help with everyday tasks.<br/>
  No API keys. No cloud. No Wi-Fi required.
</p>

## What is this?

Gabie is a fork of [gemma_chat](https://github.com/ammaarreshi/gemma-chat-public), with the goal of becoming a local-LLM-powered agent assistant.

Most AI agent tools have large tool schemas that are too computationally heavy for simple tasks and not well-suited for small local LLMs. This project aims to be an ultra-lightweight AI agent tool that invokes Tools and Skills to help with everyday tasks — your always-available personal assistant.

---

> **Note:** Small LLMs make mistakes. This project plans to conduct basic safety testing on supported models; until then, please use with caution. Basic access controls and project folder restrictions are in place, but use carefully until full testing is complete.

---

<img width="960" height="593" alt="Gabie screenshot" src="https://github.com/user-attachments/assets/b4149e63-48df-456e-8007-c607b7d46f37" />

## Features

- 🛠 **Build Mode** — Coding agent with a live preview canvas. Writes multi-file projects into a sandboxed workspace.
- 💬 **Chat Mode** — Conversational AI with tool use (web search, URL fetch, calculator, bash).
- 🔄 **Model Switching** — Hot-swap between Gemma variants on the fly.
- 🎤 **Voice Input** — Local speech-to-text via in-browser Whisper.
- ✈️ **Works Offline** — After the one-time model download, everything runs without internet.
- 💾 **Zero Config** — Python venv + MLX runtime auto-provisions on first launch.

## Available Models

| Model | Size | Best For |
|---|---|---|
| Gemma 4 E2B | ~1.5 GB | Fast Q&A, simple tasks |
| Gemma 4 E4B | ~3 GB | Speed, but not capable to execude skills |
| Gemma 4 12B | -- | -- |
| **Gemma 4 27B MoE** | **~8 GB** | **Recommended.** Stronger reasoning and able to execute skills (needs 16 GB+ RAM) |
| Gemma 4 31B | ~18 GB | Maximum quality (needs 32 GB+ RAM) |

## Models Verification (Ongoing)

| Model | Tools Ability | Skills Ability | Security Tests |
|---|---|---|---|
| Gemma 4 E2B | 3 failed | -- | Test Files 4/4 passed / Tests 78/78 passed |
| Gemma 4 E4B | ALL PASSED | ★★★☆☆ | Test Files 4/4 passed / Tests 78/78 passed |
| Gemma 4 12B | -- | -- | -- |
| Gemma 4 27B MoE | ALL PASSED | ★★★★☆ | Test Files 4/4 passed / Tests 78/78 passed |
| Gemma 4 31B | ALL PASSED | ★★★★★ | Test Files 4/4 passed / Tests 78/78 passed |
| (more models in the future ...) | -- | -- | -- |

* Smaller model might cut corners, and unable to find some files.
* Enabling "Thinking" allows local AI agents to execute more complex skills.

## Security Design

- [x] Add tool permissions
- [x] Restricted access to project folder contents
- [x] Blocklist for unsafe web fetch targets
- [x] Verify with some security tests (Total 78 tests, including bash-injection, path-traversal, ssrf and llm-adversarial)

## Getting Started

**Requirements:** macOS on Apple Silicon, Python 3.10–3.14, Node 20+.

```bash
git clone https://github.com/wukonhsieh/gabie.git
cd gabie
npm install
npm run dev
```

First launch will auto-detect Python → create a venv → install MLX-VLM → download the model (~3 GB) → ready to go.

### Building a Distributable

```bash
npm run dist
```

Produces a signed `.dmg` in `dist/`.

## Tech Stack

| Layer | Tech |
|---|---|
| App Shell | Electron + Vite + React 19 + TypeScript + Tailwind |
| Model Runtime | MLX-VLM (auto-installed into a local venv) |
| Speech-to-Text | transformers.js (Whisper, runs in-browser via WASM) |
| Workspace | Per-conversation sandboxed filesystem + local HTTP server |

## Architecture

```
src/
├── main/              Electron main process
│   ├── index.ts       Window + IPC + agent loop
│   ├── mlx.ts         MLX-VLM venv install / server lifecycle / chat streaming
│   ├── workspace.ts   Per-conversation workspace + static file server
│   └── tools.ts       Tool definitions + system prompts + XML action parser
├── preload/           contextBridge API surface
├── renderer/src/
│   ├── components/
│   │   ├── Setup.tsx      First-run onboarding + download progress
│   │   ├── Chat.tsx       Main layout + model switcher
│   │   ├── Canvas.tsx     Preview / Code / Files tabs (Build mode)
│   │   ├── Message.tsx    Chat bubbles + tool cards + activity bar
│   │   ├── Composer.tsx   Input + mic button
│   │   └── Sidebar.tsx    Conversation list
│   └── lib/whisper.ts     Browser Whisper pipeline
└── shared/types.ts    IPC types + model registry
```

## Credits

- [gemma_chat](https://github.com/ammaarreshi/gemma-chat-public) by [@ammaar](https://x.com/ammaar) — the upstream project this is forked from
- [Gemma](https://ai.google.dev/gemma) by Google DeepMind
- [MLX](https://github.com/ml-explore/mlx) by Apple Machine Learning Research
- [transformers.js](https://github.com/huggingface/transformers.js) by Hugging Face

## License

MIT
