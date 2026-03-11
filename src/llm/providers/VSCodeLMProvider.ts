import * as vscode from 'vscode';
import {
  ILLMProvider, Message, ProviderOptions, StreamChunk, ContentBlock
} from './BaseProvider';

/**
 * VSCode Language Model Provider
 *
 * Uses the VSCode built-in Language Model API (vscode.lm) which gives access
 * to GitHub Copilot and any other LM providers registered in VSCode.
 *
 * This means users can run Coding Agent with ZERO additional API keys —
 * their existing Copilot subscription (or any other VSCode-integrated LLM)
 * powers the agent automatically.
 *
 * Docs: https://code.visualstudio.com/api/extension-guides/language-model
 */
export class VSCodeLMProvider implements ILLMProvider {
  readonly name = 'copilot';

  async validateConnection(): Promise<boolean> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      return models.length > 0;
    } catch {
      return false;
    }
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async *streamMessage(
    messages: Message[],
    options: ProviderOptions,
  ): AsyncIterable<StreamChunk> {
    // Pick the best available model matching the configured model ID
    const selector = this.buildSelector(options.model);
    const [model] = await vscode.lm.selectChatModels(selector);

    if (!model) {
      yield {
        type: 'error',
        error:
          'No Copilot/VSCode Language Model available. ' +
          'Make sure GitHub Copilot Chat is installed and signed in.',
      };
      return;
    }

    // Convert our messages to VSCode LM format
    const lmMessages = this.convertMessages(messages, options.systemPrompt);

    // VSCode LM API doesn't natively support tool_use in the same way,
    // so we use a function-call prompt injection strategy for tool calls.
    const toolInstructions = this.buildToolInstructions(options.tools);
    if (toolInstructions) {
      lmMessages.unshift(vscode.LanguageModelChatMessage.User(toolInstructions));
    }

    const tokenOptions: vscode.LanguageModelChatRequestOptions = {
      justification: 'Coding Agent needs to assist with development tasks',
    };

    try {
      const response = await model.sendRequest(lmMessages, tokenOptions);

      let fullText = '';
      for await (const fragment of response.text) {
        fullText += fragment;
        yield { type: 'text', text: fragment };
      }

      // Post-process: extract any tool calls the model emitted as JSON
      yield* this.extractToolCallsFromText(fullText);

      yield { type: 'done' };
    } catch (err: unknown) {
      if (err instanceof vscode.LanguageModelError) {
        yield {
          type: 'error',
          error: `Copilot error [${err.code}]: ${err.message}`,
        };
      } else {
        yield {
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private buildSelector(modelId: string): vscode.LanguageModelChatSelector {
    // Map common model IDs to Copilot families
    if (modelId.includes('gpt-4') || modelId.includes('o1')) {
      return { vendor: 'copilot', family: 'gpt-4o' };
    }
    if (modelId.includes('claude')) {
      return { vendor: 'copilot', family: 'claude-sonnet' };
    }
    // Default: any available copilot model
    return { vendor: 'copilot' };
  }

  private convertMessages(
    messages: Message[],
    systemPrompt: string,
  ): vscode.LanguageModelChatMessage[] {
    const result: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(`[SYSTEM]\n${systemPrompt}\n[/SYSTEM]`),
    ];

    for (const msg of messages) {
      const content = this.extractTextContent(msg);
      if (!content.trim()) continue;

      if (msg.role === 'user') {
        result.push(vscode.LanguageModelChatMessage.User(content));
      } else if (msg.role === 'assistant') {
        result.push(vscode.LanguageModelChatMessage.Assistant(content));
      }
    }

    return result;
  }

  private extractTextContent(msg: Message): string {
    if (typeof msg.content === 'string') return msg.content;

    const blocks = msg.content as ContentBlock[];
    const parts: string[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        parts.push(block.text || '');
      } else if (block.type === 'tool_use') {
        parts.push(
          `[Tool call: ${block.name}(${JSON.stringify(block.input || {})})]`
        );
      } else if (block.type === 'tool_result') {
        parts.push(`[Tool result: ${block.content || ''}]`);
      }
    }

    return parts.join('\n');
  }

  private buildToolInstructions(tools: ProviderOptions['tools']): string {
    if (!tools.length) return '';

    const toolList = tools
      .map(t => {
        const params = Object.entries(t.input_schema.properties || {})
          .map(([k, v]) => `  - ${k} (${(v as any).type}): ${(v as any).description}`)
          .join('\n');
        return `### ${t.name}\n${t.description}\nParameters:\n${params}`;
      })
      .join('\n\n');

    return `You have access to the following tools. When you need to use a tool, respond with a JSON block in this exact format:

\`\`\`tool_call
{
  "name": "<tool_name>",
  "id": "<unique_id>",
  "input": { <parameters> }
}
\`\`\`

Available tools:

${toolList}

After each tool call, you will receive the result and can continue reasoning. Only call one tool at a time. When you have enough information, respond normally without a tool call.`;
  }

  /**
   * Extract tool calls from model text output (for models that emit them as JSON blocks).
   * This is the fallback strategy when the VSCode LM API doesn't support native function calling.
   */
  private async *extractToolCallsFromText(text: string): AsyncIterable<StreamChunk> {
    const TOOL_CALL_RE = /```tool_call\s*\n([\s\S]*?)\n```/g;
    let match: RegExpExecArray | null;

    while ((match = TOOL_CALL_RE.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name && parsed.input !== undefined) {
          const id = parsed.id || `tc_${Date.now()}`;
          yield {
            type: 'tool_use_start',
            tool_use_id: id,
            tool_name: parsed.name,
          };
          yield {
            type: 'tool_use_end',
            tool_use_id: id,
            tool_name: parsed.name,
            tool_input: parsed.input,
          };
        }
      } catch {
        // malformed tool call block — ignore
      }
    }
  }
}
