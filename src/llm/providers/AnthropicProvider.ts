import Anthropic from '@anthropic-ai/sdk';
import {
  ILLMProvider, Message, ProviderOptions, StreamChunk, ContentBlock
} from './BaseProvider';

export class AnthropicProvider implements ILLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async validateConnection(): Promise<boolean> {
    try {
      // Lightweight ping — send a minimal message to validate the API key
      await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return true;
    } catch (err: any) {
      // 401 = bad API key; anything else = reachable but other error → treat as valid
      if (err?.status === 401) return false;
      return true;
    }
  }

  estimateTokens(text: string): number {
    // ~4 chars per token is a rough but reliable estimate for English code
    return Math.ceil(text.length / 4);
  }

  async *streamMessage(
    messages: Message[],
    options: ProviderOptions,
  ): AsyncIterable<StreamChunk> {
    const anthropicMessages = this.convertMessages(messages);

    const stream = this.client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens,
      system: options.systemPrompt,
      temperature: options.temperature ?? 0,
      tools: options.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      messages: anthropicMessages,
    });

    let currentToolId = '';
    let currentToolName = '';
    let currentToolInputJson = '';

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          currentToolId = event.content_block.id;
          currentToolName = event.content_block.name;
          currentToolInputJson = '';
          yield {
            type: 'tool_use_start',
            tool_use_id: currentToolId,
            tool_name: currentToolName,
          };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          currentToolInputJson += event.delta.partial_json;
          yield {
            type: 'tool_use_delta',
            tool_use_id: currentToolId,
            tool_input_delta: event.delta.partial_json,
          };
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolId) {
          try {
            const parsed = JSON.parse(currentToolInputJson || '{}');
            yield {
              type: 'tool_use_end',
              tool_use_id: currentToolId,
              tool_name: currentToolName,
              tool_input: parsed,
            };
          } catch {
            yield {
              type: 'tool_use_end',
              tool_use_id: currentToolId,
              tool_name: currentToolName,
              tool_input: {},
            };
          }
          currentToolId = '';
          currentToolName = '';
          currentToolInputJson = '';
        }
      } else if (event.type === 'message_delta') {
        if (event.usage) {
          yield {
            type: 'done',
            usage: {
              input_tokens: 0, // populated in message_start
              output_tokens: event.usage.output_tokens,
            },
          };
        }
      } else if (event.type === 'message_start') {
        // Capture input token usage
        if (event.message.usage) {
          yield {
            type: 'text',
            text: '',
            usage: {
              input_tokens: event.message.usage.input_tokens,
              output_tokens: event.message.usage.output_tokens,
            },
          };
        }
      }
    }
  }

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content });
        } else {
          const blocks: (Anthropic.TextBlockParam | Anthropic.ToolResultBlockParam)[] = (msg.content as ContentBlock[]).map(b => {
            if (b.type === 'tool_result') {
              return {
                type: 'tool_result' as const,
                tool_use_id: b.tool_use_id!,
                content: b.content || '',
              };
            }
            return { type: 'text' as const, text: b.text || '' };
          });
          result.push({ role: 'user', content: blocks });
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'assistant', content: msg.content });
        } else {
          const blocks: (Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam)[] = (msg.content as ContentBlock[]).map(b => {
            if (b.type === 'tool_use') {
              return {
                type: 'tool_use' as const,
                id: b.id!,
                name: b.name!,
                input: b.input || {},
              };
            }
            return { type: 'text' as const, text: b.text || '' };
          });
          result.push({ role: 'assistant', content: blocks });
        }
      }
    }

    return result;
  }
}
