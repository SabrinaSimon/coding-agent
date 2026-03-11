import { ToolSchema } from '../../tools/base/Tool';

export interface Message {
  role: 'user' | 'assistant' | 'tool_result';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  id?: string;
  name?: string;           // for tool_use
  input?: Record<string, unknown>; // for tool_use
  content?: string;        // for tool_result
  tool_use_id?: string;    // for tool_result
  text?: string;           // for text
}

export interface StreamChunk {
  type: 'text' | 'tool_use_start' | 'tool_use_delta' | 'tool_use_end' | 'done' | 'error';
  text?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input_delta?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  usage?: TokenUsage;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface ProviderOptions {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  tools: ToolSchema[];
  temperature?: number;
}

/**
 * All LLM providers implement this interface, allowing the agent core
 * to be completely provider-agnostic.
 */
export interface ILLMProvider {
  readonly name: string;

  /** Stream a response, yielding chunks as they arrive. */
  streamMessage(
    messages: Message[],
    options: ProviderOptions,
  ): AsyncIterable<StreamChunk>;

  /** Estimate token count for a string (best-effort). */
  estimateTokens(text: string): number;

  /** Validate the API key is set and reachable. */
  validateConnection(): Promise<boolean>;
}
