import OpenAI from 'openai';
import {
  ILLMProvider, Message, ProviderOptions, StreamChunk, ContentBlock
} from './BaseProvider';

export class OpenAIProvider implements ILLMProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async validateConnection(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
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
    const oaiMessages = this.convertMessages(messages, options.systemPrompt);
    const tools = options.tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const stream = await this.client.chat.completions.create({
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0,
      tools,
      stream: true,
      messages: oaiMessages,
    });

    const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: 'text', text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' });
            yield {
              type: 'tool_use_start',
              tool_use_id: tc.id || `tc_${idx}`,
              tool_name: tc.function?.name || '',
            };
          }
          const existing = toolCalls.get(idx)!;
          if (tc.function?.arguments) {
            existing.args += tc.function.arguments;
            yield {
              type: 'tool_use_delta',
              tool_use_id: existing.id,
              tool_input_delta: tc.function.arguments,
            };
          }
        }
      }

      // Finish reason = tool_calls means all tool use blocks are done
      if (chunk.choices[0]?.finish_reason === 'tool_calls') {
        for (const [, tc] of toolCalls) {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(tc.args || '{}'); } catch { /* ignore */ }
          yield {
            type: 'tool_use_end',
            tool_use_id: tc.id,
            tool_name: tc.name,
            tool_input: parsed,
          };
        }
        toolCalls.clear();
      }

      if (chunk.choices[0]?.finish_reason === 'stop') {
        yield { type: 'done' };
      }
    }
  }

  private convertMessages(
    messages: Message[],
    systemPrompt: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content });
        } else {
          // Handle tool results as tool messages
          const toolResults = (msg.content as ContentBlock[]).filter(b => b.type === 'tool_result');
          const textBlocks = (msg.content as ContentBlock[]).filter(b => b.type === 'text');

          for (const tr of toolResults) {
            result.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id!,
              content: tr.content || '',
            });
          }
          if (textBlocks.length) {
            result.push({
              role: 'user',
              content: textBlocks.map(b => b.text || '').join('\n'),
            });
          }
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'assistant', content: msg.content });
        } else {
          const toolUses = (msg.content as ContentBlock[]).filter(b => b.type === 'tool_use');
          const textBlocks = (msg.content as ContentBlock[]).filter(b => b.type === 'text');

          result.push({
            role: 'assistant',
            content: textBlocks.map(b => b.text || '').join('') || null,
            tool_calls: toolUses.map(b => ({
              id: b.id!,
              type: 'function' as const,
              function: {
                name: b.name!,
                arguments: JSON.stringify(b.input || {}),
              },
            })),
          });
        }
      }
    }

    return result;
  }
}
