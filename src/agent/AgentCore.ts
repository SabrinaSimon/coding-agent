import * as vscode from 'vscode';
import { ILLMProvider, Message, ContentBlock, StreamChunk } from '../llm/providers/BaseProvider';
import { ToolRegistry } from './ToolRegistry';
import { PermissionManager, PermissionDecision } from '../permissions/PermissionManager';
import { MemoryManager } from '../memory/MemoryManager';
import { ToolContext, ToolInput } from '../tools/base/Tool';

export interface AgentEvent {
  type:
    | 'text_delta'       // streaming text from LLM
    | 'tool_start'       // tool about to execute
    | 'tool_result'      // tool finished
    | 'tool_denied'      // user denied permission
    | 'error'            // unrecoverable error
    | 'done'             // turn complete
    | 'thinking';        // agent reasoning (optional extended thinking)
  text?: string;
  tool?: {
    id: string;
    name: string;
    input?: Record<string, unknown>;
    result?: string;
    success?: boolean;
    duration?: number;
  };
  error?: string;
}

export type AgentEventHandler = (event: AgentEvent) => void;

interface PendingToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

const SYSTEM_PROMPT = `You are Coding Agent, an enterprise-grade AI software engineer embedded in VSCode. You can autonomously perform any development task: reading and writing code, running tests, debugging, refactoring, searching the codebase, executing shell commands, and more.

## Core Principles
- **Understand before acting**: Read relevant files before modifying them. Explore the codebase to understand patterns and conventions.
- **Minimal changes**: Only modify what is necessary. Prefer editing existing files over creating new ones.
- **Verify your work**: After making changes, check for errors. Run tests when available.
- **Communicate clearly**: Explain what you are doing and why. Show diffs when making code changes.
- **Ask when uncertain**: If requirements are ambiguous, ask a clarifying question before proceeding with a large change.
- **Security first**: Never introduce vulnerabilities. Do not store secrets in code.

## Tool Usage Guidelines
- Use \`read_file\` before editing any file
- Use \`grep\` and \`glob\` to explore before assuming file locations
- Use \`bash\` for building, testing, and package management
- Use \`git\` to check status and show diffs before committing
- Always prefer the most targeted tool available

## Output Format
- Use Markdown for formatted responses
- Use fenced code blocks with language identifiers
- Show file paths as \`path/to/file.ts\`
- When showing diffs, use diff fenced blocks

You have access to the full workspace and can act autonomously. Proceed step-by-step and always verify your work.`;

/**
 * The agentic loop.
 *
 * Flow:
 *   1. User sends message
 *   2. Build messages array (history + new user message)
 *   3. Stream LLM response
 *   4. Collect text and tool_use blocks
 *   5. For each tool_use: request permission → execute → append tool_result
 *   6. If there were tool calls, loop back to step 3 with updated messages
 *   7. If no tool calls (stop_reason = end_turn), return final text to UI
 */
export class AgentCore {
  private abortController: AbortController | null = null;
  private messages: Message[] = [];

  constructor(
    private provider: ILLMProvider,
    private toolRegistry: ToolRegistry,
    private permissionManager: PermissionManager,
    private memoryManager: MemoryManager,
    private extensionContext: vscode.ExtensionContext,
    private outputChannel: vscode.OutputChannel,
  ) {}

  /** Send a user message and stream the agent's response via events. */
  async chat(
    userMessage: string,
    onEvent: AgentEventHandler,
  ): Promise<void> {
    this.abortController = new AbortController();

    // Add user message to history
    this.messages.push({ role: 'user', content: userMessage });
    this.memoryManager.addMessage('user', userMessage);

    const memoryInstruction = await this.memoryManager.getProjectMemoryInstruction();
    const systemPrompt = SYSTEM_PROMPT + memoryInstruction;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;

    const toolContext: ToolContext = {
      workspaceRoot,
      extensionContext: this.extensionContext,
      outputChannel: this.outputChannel,
      activeFile,
      signal: this.abortController.signal,
    };

    const config = vscode.workspace.getConfiguration('codingAgent');
    const model = config.get<string>('model', 'claude-sonnet-4-6');
    const maxTokens = config.get<number>('maxTokens', 8192);

    try {
      await this.runLoop(systemPrompt, model, maxTokens, toolContext, onEvent);
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        onEvent({ type: 'done' });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        onEvent({ type: 'error', error: message });
      }
    } finally {
      this.abortController = null;
    }
  }

  /** Abort the current turn. */
  abort(): void {
    this.abortController?.abort();
  }

  /** Clear conversation history. */
  clearHistory(): void {
    this.messages = [];
    this.memoryManager.clearHistory();
  }

  getHistory(): Message[] {
    return this.messages;
  }

  // ─── Private: Core Loop ──────────────────────────────────────────────────────

  private async runLoop(
    systemPrompt: string,
    model: string,
    maxTokens: number,
    toolContext: ToolContext,
    onEvent: AgentEventHandler,
  ): Promise<void> {
    const MAX_ITERATIONS = 30; // safety guard against infinite loops
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      this.log(`[AgentCore] Iteration ${iterations} — calling LLM`);

      const { assistantContent, pendingToolCalls } = await this.streamLLMResponse(
        systemPrompt, model, maxTokens, toolContext, onEvent,
      );

      // Append assistant message
      this.messages.push({ role: 'assistant', content: assistantContent });

      if (pendingToolCalls.length === 0) {
        // No tool calls → the turn is complete
        const assistantText = assistantContent
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('');
        this.memoryManager.addMessage('assistant', assistantText);
        break;
      }

      // Execute tools and collect results
      const toolResultBlocks = await this.executeTools(pendingToolCalls, toolContext, onEvent);

      // Append tool results as a user message (Anthropic's expected format)
      this.messages.push({
        role: 'user',
        content: toolResultBlocks,
      });
    }

    if (iterations >= MAX_ITERATIONS) {
      onEvent({ type: 'error', error: 'Agent reached maximum iteration limit. Stopping to prevent infinite loop.' });
    }

    onEvent({ type: 'done' });
  }

  private async streamLLMResponse(
    systemPrompt: string,
    model: string,
    maxTokens: number,
    toolContext: ToolContext,
    onEvent: AgentEventHandler,
  ): Promise<{ assistantContent: ContentBlock[]; pendingToolCalls: PendingToolCall[] }> {
    const assistantContent: ContentBlock[] = [];
    const pendingToolCalls: PendingToolCall[] = [];
    const pendingToolInputs: Map<string, string> = new Map();

    let currentTextBlock = '';

    const stream = this.provider.streamMessage(this.messages, {
      model,
      maxTokens,
      systemPrompt,
      tools: this.toolRegistry.getSchemas(),
      temperature: 0,
    });

    for await (const chunk of stream) {
      if (this.abortController?.signal.aborted) break;

      await this.handleStreamChunk(
        chunk,
        assistantContent,
        pendingToolCalls,
        pendingToolInputs,
        onEvent,
        (text) => { currentTextBlock = text; },
      );
    }

    // Flush remaining text block
    if (currentTextBlock) {
      assistantContent.push({ type: 'text', text: currentTextBlock });
    }

    return { assistantContent, pendingToolCalls };
  }

  private async handleStreamChunk(
    chunk: StreamChunk,
    assistantContent: ContentBlock[],
    pendingToolCalls: PendingToolCall[],
    pendingToolInputs: Map<string, string>,
    onEvent: AgentEventHandler,
    updateText: (text: string) => void,
  ): Promise<void> {
    switch (chunk.type) {
      case 'text':
        if (chunk.text) {
          // Accumulate text
          const existing = assistantContent.findIndex(b => b.type === 'text' && !b.id);
          if (existing >= 0) {
            assistantContent[existing].text = (assistantContent[existing].text || '') + chunk.text;
          } else {
            assistantContent.push({ type: 'text', text: chunk.text });
          }
          updateText(chunk.text);
          onEvent({ type: 'text_delta', text: chunk.text });
        }
        break;

      case 'tool_use_start':
        pendingToolInputs.set(chunk.tool_use_id!, '');
        break;

      case 'tool_use_delta':
        if (chunk.tool_use_id) {
          const existing = pendingToolInputs.get(chunk.tool_use_id) || '';
          pendingToolInputs.set(chunk.tool_use_id, existing + (chunk.tool_input_delta || ''));
        }
        break;

      case 'tool_use_end':
        if (chunk.tool_use_id && chunk.tool_name && chunk.tool_input) {
          assistantContent.push({
            type: 'tool_use',
            id: chunk.tool_use_id,
            name: chunk.tool_name,
            input: chunk.tool_input,
          });
          pendingToolCalls.push({
            id: chunk.tool_use_id,
            name: chunk.tool_name,
            input: chunk.tool_input,
          });
        }
        break;

      case 'error':
        onEvent({ type: 'error', error: chunk.error });
        break;
    }
  }

  private async executeTools(
    toolCalls: PendingToolCall[],
    toolContext: ToolContext,
    onEvent: AgentEventHandler,
  ): Promise<ContentBlock[]> {
    const results: ContentBlock[] = [];

    for (const tc of toolCalls) {
      const tool = this.toolRegistry.get(tc.name);

      if (!tool) {
        results.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: `Error: Unknown tool "${tc.name}"`,
        });
        continue;
      }

      // Check permission
      const permission = await this.permissionManager.requestPermission(tool, tc.input as ToolInput);

      if (permission === PermissionDecision.DENY) {
        onEvent({
          type: 'tool_denied',
          tool: { id: tc.id, name: tc.name, input: tc.input },
        });
        results.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: 'Tool execution denied by user.',
        });
        continue;
      }

      onEvent({
        type: 'tool_start',
        tool: { id: tc.id, name: tc.name, input: tc.input },
      });

      const startTime = Date.now();
      this.log(`[Tool] Executing: ${tc.name}(${JSON.stringify(tc.input).slice(0, 200)})`);

      try {
        const result = await tool.execute(tc.input as ToolInput, toolContext);
        const duration = Date.now() - startTime;

        this.log(`[Tool] ${tc.name} → ${result.success ? 'OK' : 'ERR'} (${duration}ms)`);

        onEvent({
          type: 'tool_result',
          tool: {
            id: tc.id,
            name: tc.name,
            input: tc.input,
            result: result.output || result.error || '',
            success: result.success,
            duration,
          },
        });

        const content = result.success
          ? result.output
          : `Error: ${result.error}\n${result.output}`;

        results.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: content.slice(0, 50_000), // hard cap to protect context window
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`[Tool] ${tc.name} threw exception: ${message}`);

        results.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: `Exception during tool execution: ${message}`,
        });
      }
    }

    return results;
  }

  private log(message: string): void {
    this.outputChannel.appendLine(message);
  }
}
