**English | [简体中文](README.zh-CN.md)**

<p align="center"><img src="notus/public/notus-logo.svg" width="112" alt="Notus Logo" /></p>

<p align="center">A local-first Markdown knowledge workspace with a built-in AI Agent for writing, research, and reviewable file edits.</p>

---

## Table of Contents

- [What It Is](#what-it-is)
- [Core Features](#core-features)
- [Write Control & Task Safety](#write-control--task-safety)
- [Data & Privacy](#data--privacy)
- [Platforms](#platforms)
- [Running Locally](#running-locally)
- [Building & Packaging](#building--packaging)
- [Project Structure](#project-structure)
- [Links](#links)

---

## What It Is

Notus treats Markdown files as the center of your workspace. You can edit notes, search your own material, let the AI Agent research or write on your behalf, and review every file change before it lands.

---

## Core Features

### Edit & Manage Markdown

- Rich-text editor with bidirectional Markdown conversion, syntax highlighting, tables, outline view, and file search.
- Files are saved to your local workspace; changes are incrementally indexed into the knowledge base.
- Browse a persistent file tree, search notes by title or path, and open files directly from search results or diff previews.
- Editor and AI panel layout, toggle states, current file, and shortcuts are all saved locally and restored on next launch.
- Optionally sync note titles to the Markdown H1 heading and filename; conflicts are surfaced without silently overwriting saved content.
- When pasting or inserting images, choose between writing to a local asset directory or uploading to Alibaba Cloud OSS, Tencent Cloud COS, or Cloudflare R2.
- Imported documents enter the knowledge base; Agent conversations also accept parsed attachments, images, and explicitly pasted URLs.

### Search Your Knowledge Base

- Hybrid retrieval: vector search + FTS5 keyword matching + title/path matching + segment aggregation + conditional reranking.
- Answers include traceable citations so you can verify against the original note.
- The Agent reads files, analyzes directories, or searches the knowledge base as the task demands — it does not treat the currently open editor file as implicit context.
- File and directory Mentions scope retrieval; directories are analyzed in batches, not read wholesale for a single reference.
- When evidence is thin, the task plans multiple search queries automatically; repeated research within the same task reuses the cache. Notes, attachments, URLs, and web search always maintain clear source boundaries.

### Use Documents, Images, and URLs in Conversation

- Accepts PDF, DOCX, Markdown, plain text, and readable web pages as conversation material; attachments and image inputs are handled separately.
- Paste or upload images for visual analysis; image summaries and controlled references persist across subsequent turns in the same conversation.
- When organizing conversation images into notes, the Agent generates a text-and-image diff, verifies the target file version, and writes images according to your configured image host on apply.
- Past conversations can be searched by title or message content and exported; reopening a saved conversation restores pending tasks and prior tool records.

### AI Agent Writing & Research

- Start a conversation without opening any file; type `@` to reference files, directories, or enabled Skills.
- Agent tasks run in the background via a persistent queue, with SSE updates, resumable checkpoints, tool records, and per-conversation task history.
- Creating or switching conversations does not cancel a running task; returning to the original conversation restores state, tool records, and the resume entry point.
- The Agent asks clarifying questions when it needs information; file writes produce a Markdown diff that supports auto-apply, manual confirmation, or rollback.
- The Agent can create, modify, rename, and move Markdown files or directories inside a controlled preview; no delete tool is currently provided.
- Editing or retrying an AI reply resumes from the original message position without creating duplicate conversation branches.
- When a model request fails or is waiting for a user answer, execution resumes from the saved checkpoint without restarting the task.
- Web search is toggled per task; supported providers: Firecrawl, Tavily, Exa, Zhipu Web Search.
- The model selector supports search by model name, provider, or config name; a single task can combine text, attachments, images, local notes, and on-demand web research.

### Extend the Agent

- Skills can be installed from a local directory, an HTTPS Git repository, a ZIP archive, or an Agent draft; they can be enabled, disabled, updated, and rescanned in Settings. Enabled Skills are selectable from the `@` menu.
- Streamable HTTP MCP is supported on all platforms; stdio MCP is additionally available on the Electron desktop. Headers and environment variables are stored as secrets and never appear in listings, tool results, or logs.
- Notus can also act as a Streamable HTTP MCP Server, exposing selected note read/write tools to external Agents; writes can be set to auto-apply or require diff confirmation.
- `soul.md`, `memory.md`, and `style.md` store long-term preferences, writing style, and persona references — all with history and rollback.
- External MCP tokens are managed separately from server configuration. Tokens expose only the tools the user has enabled; the database stores only the token hash. Write operations also verify the current note hash.

---

## Write Control & Task Safety

- Choose auto-apply for qualifying writes, or require manual review for every file change.
- Every write preview is compared against the current version of the target file before applying; if the file has changed, the preview is returned rather than silently overwriting.
- Agent questions appear as inline cards; answering resumes the same task.
- Pending confirmation, pending answers, recoverable failures, and interrupted tasks are all retained in conversation history.
- Task events are persisted before being pushed via SSE, so tool records and final replies survive page refreshes, browser disconnects, and app restarts.
- Pre-send task input is saved in browser IndexedDB; text, Mentions, attachments, and image metadata can all be recovered in the browser.

---

## Data & Privacy

- Markdown files are the single source of truth; SQLite stores the index, conversations, previews, and task state locally.
- Editing and local knowledge base search require no Notus hosted account.
- Model calls, web search, object storage, and MCP connections are all optional capabilities using providers and credentials you configure yourself.
- Secrets are never written to API responses, Agent events, tool results, or logs.
- Skill files, MCP responses, web pages, and attachments are all treated as untrusted task material and cannot expand file permissions or override Agent safety rules.

---

## Platforms

| Platform | Details |
| --- | --- |
| Web | Next.js standalone build |
| Desktop | Electron app for macOS and Windows |
| Lazy Cat | Compatibility support retained |

The Web and desktop builds share the same Next.js standalone output. Platform-specific capabilities such as stdio MCP are determined by the platform layer, not by runtime environment checks in the application code.

---

## Running Locally

### Requirements

- Node.js 20.19.x
- npm

### Start the Development Environment

```bash
npm install

# Start the Web dev server
npm run dev:web

# Connect Electron to a running http://127.0.0.1:3000
npm run dev:desktop

# Start both Web and Electron together
npm run dev:desktop:all
```

To configure a model or search service, copy `notus/.env.local.example` to `notus/.env.local` and fill in the relevant values. Supported settings can also be managed in the application's Settings panel.

---

## Building & Packaging

```bash
# Lint and build the Web app
npm run lint:web
npm run build:web

# Run repository tests
npm run test:all

# Export the Web standalone directory
npm run dist:web

# Prepare or package Electron
npm run build:desktop
npm run dist:desktop

# Target-specific desktop installers
npm run dist:desktop:mac:x64
npm run dist:desktop:mac:arm64
npm run dist:desktop:win:x64

# Package the Lazy Cat installer
npm run dist:lpk
```

| Output | Path |
| --- | --- |
| Web standalone | `web-dist/` |
| Electron installer | `desktop/dist/` |
| Lazy Cat package | Repository root |

---

## Project Structure

```text
notus/     Next.js pages, components, API Routes, and core business libraries
desktop/   Electron main process, preload bridge, and packaging scripts
docs/      Product, technical, and workflow documentation
```

---

## Links

- Website: [notus.hejiajun.com](https://notus.hejiajun.com/)
- GitHub: [github.com/dnwwdwd/Notus](https://github.com/dnwwdwd/Notus)
- License: [Apache-2.0](LICENSE)

Issues and Pull Requests are welcome. Please read `AGENTS.md` before contributing and follow the code, test, and documentation conventions in the repository.
