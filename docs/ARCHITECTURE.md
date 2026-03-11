# Coding Agent — Architecture

## Overview
Coding Agent is an enterprise-grade VSCode extension that acts as an autonomous AI developer. It uses a streaming agentic loop (similar to Claude Code / Cursor) to reason, plan, and execute development tasks with access to filesystem, shell, git, and web tools.

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        VSCode Extension Host                     │
│                                                                  │
│  ┌──────────────────┐     ┌─────────────────────────────────┐   │
│  │    ChatPanel     │────▶│          Extension.ts           │   │
│  │  (WebView UI)    │◀────│  (Command Registration / DI)   │   │
│  └──────────────────┘     └──────────────┬──────────────────┘   │
│                                          │                       │
│                           ┌──────────────▼──────────────────┐   │
│                           │          AgentCore              │   │
│                           │   (Agentic Loop / Orchestrator) │   │
│                           └──┬──────────┬──────────┬────────┘   │
│                              │          │          │             │
│               ┌──────────────▼──┐  ┌───▼───┐  ┌──▼──────────┐ │
│               │  LLM Provider   │  │ Tool  │  │ Permission  │ │
│               │  (Anthropic /   │  │Registry│  │  Manager   │ │
│               │   OpenAI)       │  └───┬───┘  └──────────── ┘ │
│               └─────────────────┘      │                       │
│                                        │                       │
│               ┌────────────────────────▼──────────────────┐   │
│               │                  Tools                     │   │
│               │  ReadTool  WriteTool  EditTool  GlobTool   │   │
│               │  GrepTool  BashTool   GitTool  WebFetch    │   │
│               └───────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              ContextManager + MemoryManager              │   │
│  │   (Codebase Index, Uploaded Docs, Project Memory)        │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. AgentCore (src/agent/AgentCore.ts)
The heart of the system. Implements the **agentic loop**:
1. User sends a message
2. Messages are forwarded to the LLM with tool schemas attached
3. LLM responds with text and/or tool_use blocks (streaming)
4. Each tool_use is permission-checked, then executed
5. Tool results are appended as tool_result blocks
6. Loop repeats until LLM produces a final answer (no more tool calls)
7. Maximum 30 iterations per turn to prevent infinite loops

### 2. Tool System (src/tools/)
All tools extend `BaseTool` and declare:
- `name` — unique identifier used in tool_use blocks
- `description` — shown to the LLM in tool definitions
- `riskLevel` — SAFE / CAUTION / DANGER (drives permission prompts)
- `schema` — JSON Schema describing inputs (both Anthropic and OpenAI formats)
- `execute()` — async implementation
- `summarize()` — human-readable description for approval dialogs

| Tool | Risk | Purpose |
|------|------|---------|
| read_file | SAFE | Read file contents with line numbers |
| write_file | DANGER | Write/create files |
| edit_file | DANGER | Exact string replacement in files |
| glob | SAFE | Find files by pattern |
| grep | SAFE | Search file contents by regex |
| bash | DANGER | Execute shell commands |
| git | CAUTION/DANGER | Git operations |
| web_fetch | CAUTION | Fetch and read URLs |

### 3. LLM Providers (src/llm/)
Provider abstraction allows swapping between Anthropic and OpenAI without changing agent logic. Both implement `ILLMProvider`:
- `streamMessage()` — returns an `AsyncIterable<StreamChunk>`
- `estimateTokens()` — rough token estimate for context management
- `validateConnection()` — health check

### 4. Permission Manager (src/permissions/)
Gatekeeper for all tool executions:
- SAFE risk → auto-allow
- Check `codingAgent.autoApprove*` settings
- Check session grants (user said "allow for this session")
- Otherwise show VSCode quick-pick dialog

### 5. Context Manager (src/agent/ContextManager.ts)
Enterprise context injection:
- **Workspace indexing** — scans and catalogs all code files
- **Architecture docs** — auto-discovers ARCHITECTURE.md, docs/design/**, ADR/**
- **Business rules** — auto-discovers REQUIREMENTS.md, docs/business/**, *.spec.md
- **Coding standards** — auto-discovers .eslintrc, CONTRIBUTING.md, STYLE_GUIDE.md
- **Document upload** — users can upload PDFs, DOCX, Markdown, JSON, YAML

All discovered context is injected into the system prompt so the agent understands the enterprise's conventions before writing a single line of code.

### 6. Memory Manager (src/memory/)
- **Project memory** — reads/writes `AGENTS.md` (configurable) at workspace root
- **Session history** — in-memory conversation messages
- **Context trimming** — removes oldest messages when approaching token limits

### 7. Chat Panel (src/ui/ChatPanel.ts)
VSCode WebView panel with a rich chat UI:
- Streaming text rendering
- Tool call visualisation (tool name, inputs, status, duration)
- Document upload dialog
- Workspace indexing trigger
- Markdown rendering with code blocks
- Keyboard shortcuts (Ctrl+Enter to send)

---

## Agentic Loop Detail

```
User Message
     │
     ▼
Build Messages Array
(history + new user msg)
     │
     ▼
Stream LLM Response ◀─────────────────────────────┐
     │                                              │
     ▼                                              │
Collect: text_delta, tool_use blocks                │
     │                                              │
     ├─── No tool calls? ──▶ DONE (final answer)   │
     │                                              │
     ▼                                              │
For each tool_use:                                  │
  1. Check permission (SAFE/session/dialog)         │
  2. Execute tool                                   │
  3. Emit tool_start / tool_result events to UI     │
  4. Collect tool_result content block             │
     │                                              │
     ▼                                              │
Append assistant msg + tool_result user msg         │
     │                                              │
     └────────────────────────────────────────────▶┘
           (next iteration, max 30)
```

---

## Enterprise Features

### Document & Codebase Context
The agent automatically builds context from:
1. Existing architecture docs (ARCHITECTURE.md, ADR/**, docs/design/**)
2. Business rule documents (REQUIREMENTS.md, docs/business/**)
3. Coding standards (.eslintrc, CONTRIBUTING.md, pyproject.toml)
4. User-uploaded documents (PDF, DOCX, MD, YAML, JSON)

This ensures the agent follows your organisation's conventions without being told explicitly.

### Security
- API keys stored in VSCode Secret Storage (OS keychain backed)
- Dangerous shell commands blocked by regex pattern matching
- All write/exec operations require explicit user approval by default
- Tool output capped at 50KB to protect context window
- Shell command timeout: 2min default, 10min max

### Multi-Provider
Switch between Anthropic Claude and OpenAI GPT-4o via a single config setting. The agent loop, tools, and UI are completely provider-agnostic.

---

## Adding a New Tool
1. Create `src/tools/<category>/MyTool.ts` extending `BaseTool`
2. Implement `name`, `description`, `riskLevel`, `schema`, `execute()`, `summarize()`
3. Register in `ToolRegistry` constructor
4. The tool is immediately available to the LLM

---

## Configuration
All settings under `codingAgent.*` in VSCode settings:
- `provider` — anthropic | openai
- `model` — model ID (e.g. claude-sonnet-4-6)
- `maxTokens` — max tokens per response
- `autoApproveReads` — default true
- `autoApproveWrites` — default false (require confirmation)
- `autoApproveBash` — default false (require confirmation)
- `memoryFile` — project memory file name (default: AGENTS.md)
- `enableMemory` — enable persistent memory
