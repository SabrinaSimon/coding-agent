import { BaseTool, RiskLevel, ToolInput, ToolResult, ToolSchema, ToolContext } from '../base/Tool';

interface WebFetchInput extends ToolInput {
  url: string;
  max_length?: number;
}

export class WebFetchTool extends BaseTool {
  readonly name = 'web_fetch';
  readonly description =
    'Fetch the content of a URL and return it as plain text. Useful for reading documentation, API references, or any web resource referenced in code.';
  readonly riskLevel = RiskLevel.CAUTION;

  readonly schema: ToolSchema = {
    name: this.name,
    description: this.description,
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
        max_length: {
          type: 'number',
          description: 'Maximum characters to return. Default: 20000',
        },
      },
      required: ['url'],
    },
  };

  summarize(input: ToolInput): string {
    return `Fetch: ${(input as WebFetchInput).url}`;
  }

  async execute(input: ToolInput, _context: ToolContext): Promise<ToolResult> {
    const { url, max_length = 20_000 } = input as WebFetchInput;

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'CodingAgent/1.0' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return {
          success: false,
          output: '',
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const contentType = response.headers.get('content-type') || '';
      let text: string;

      if (contentType.includes('text/html')) {
        const html = await response.text();
        text = this.stripHtml(html);
      } else {
        text = await response.text();
      }

      const truncated = text.length > max_length ? text.slice(0, max_length) + '\n\n[...truncated]' : text;

      return {
        success: true,
        output: truncated,
        metadata: { url, content_type: contentType, chars: text.length },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Fetch failed: ${message}` };
    }
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\s{3,}/g, '\n\n')
      .trim();
  }
}
