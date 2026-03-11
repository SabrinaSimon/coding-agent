import * as fs from 'fs/promises';
import * as path from 'path';
import { BaseTool, RiskLevel, ToolInput, ToolResult, ToolSchema, ToolContext } from '../base/Tool';

interface ReadInput extends ToolInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export class ReadTool extends BaseTool {
  readonly name = 'read_file';
  readonly description =
    'Read the contents of a file from the filesystem. Returns the file content with line numbers. Use offset and limit to read large files in chunks.';
  readonly riskLevel = RiskLevel.SAFE;

  readonly schema: ToolSchema = {
    name: this.name,
    description: this.description,
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or workspace-relative path to the file to read',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (1-indexed). Default: 1',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read. Default: 2000',
        },
      },
      required: ['file_path'],
    },
  };

  summarize(input: ToolInput): string {
    return `Read file: ${(input as ReadInput).file_path}`;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const { file_path, offset = 1, limit = 2000 } = input as ReadInput;

    const resolved = this.resolvePath(file_path, context.workspaceRoot);

    try {
      const raw = await fs.readFile(resolved, 'utf-8');
      const allLines = raw.split('\n');
      const startIdx = Math.max(0, offset - 1);
      const endIdx = Math.min(allLines.length, startIdx + limit);
      const lines = allLines.slice(startIdx, endIdx);

      const numbered = lines
        .map((line, i) => `${String(startIdx + i + 1).padStart(6, ' ')}\t${line}`)
        .join('\n');

      const meta = {
        total_lines: allLines.length,
        returned_lines: lines.length,
        start_line: startIdx + 1,
        end_line: endIdx,
        path: resolved,
      };

      return {
        success: true,
        output: numbered,
        metadata: meta,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Failed to read file: ${message}` };
    }
  }

  private resolvePath(filePath: string, workspaceRoot: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(workspaceRoot, filePath);
  }
}
