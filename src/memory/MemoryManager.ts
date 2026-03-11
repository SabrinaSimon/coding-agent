import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ProjectMemory {
  content: string;
  filePath: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * Manages two types of memory:
 *   1. Project memory  — AGENTS.md (or configured file) at the workspace root
 *   2. Session history — in-memory conversation messages (no persistence by default)
 *
 * The project memory is injected into every system prompt so the model
 * remembers project conventions, preferred libraries, and past decisions.
 */
export class MemoryManager {
  private history: ConversationMessage[] = [];
  private projectMemoryCache: string | null = null;

  constructor(
    private workspaceRoot: string,
    private extensionContext: vscode.ExtensionContext,
  ) {}

  // ─── Project Memory ──────────────────────────────────────────────────────────

  async loadProjectMemory(): Promise<ProjectMemory | null> {
    const config = vscode.workspace.getConfiguration('codingAgent');
    const fileName = config.get<string>('memoryFile', 'AGENTS.md');
    const filePath = path.join(this.workspaceRoot, fileName);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.projectMemoryCache = content;
      return { content, filePath };
    } catch {
      return null;
    }
  }

  async saveProjectMemory(content: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('codingAgent');
    const fileName = config.get<string>('memoryFile', 'AGENTS.md');
    const filePath = path.join(this.workspaceRoot, fileName);

    await fs.writeFile(filePath, content, 'utf-8');
    this.projectMemoryCache = content;
  }

  getProjectMemorySync(): string | null {
    return this.projectMemoryCache;
  }

  async getProjectMemoryInstruction(): Promise<string> {
    const mem = await this.loadProjectMemory();
    if (!mem) return '';
    return `\n\n## Project Memory (${path.basename(mem.filePath)})\n${mem.content}`;
  }

  // ─── Session History ─────────────────────────────────────────────────────────

  addMessage(role: 'user' | 'assistant', content: string): void {
    this.history.push({ role, content, timestamp: Date.now() });
  }

  getHistory(): ConversationMessage[] {
    return this.history;
  }

  clearHistory(): void {
    this.history = [];
  }

  /**
   * Trim conversation history to stay within a token budget.
   * Removes oldest messages first but keeps the first user message as anchor.
   */
  trimHistory(maxTokenEstimate: number): void {
    const CHARS_PER_TOKEN = 4;
    const maxChars = maxTokenEstimate * CHARS_PER_TOKEN;

    let totalChars = this.history.reduce((sum, m) => sum + m.content.length, 0);

    // Keep at least the last 2 messages
    while (totalChars > maxChars && this.history.length > 2) {
      const removed = this.history.splice(1, 1); // remove second message (keep first)
      totalChars -= removed[0].content.length;
    }
  }
}
