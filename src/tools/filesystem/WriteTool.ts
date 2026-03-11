import * as fs from 'fs/promises';
import * as path from 'path';
import { BaseTool, RiskLevel, ToolInput, ToolResult, ToolSchema, ToolContext } from '../base/Tool';

interface WriteInput extends ToolInput {
  file_path: string;
  content: string;
}

export class WriteTool extends BaseTool {
  readonly name = 'write_file';
  readonly description =
    'Write content to a file, creating it (and any missing parent directories) if it does not exist, or completely overwriting it if it does. Always read the file first before overwriting.';
  readonly riskLevel = RiskLevel.DANGER;

  readonly schema: ToolSchema = {
    name: this.name,
    description: this.description,
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or workspace-relative path to the file to write',
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file',
        },
      },
      required: ['file_path', 'content'],
    },
  };

  summarize(input: ToolInput): string {
    const { file_path, content } = input as WriteInput;
    const lines = content.split('\n').length;
    return `Write ${lines} lines to: ${file_path}`;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const { file_path, content } = input as WriteInput;
    const resolved = this.resolvePath(file_path, context.workspaceRoot);

    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');

      return {
        success: true,
        output: `File written successfully: ${resolved}`,
        metadata: {
          path: resolved,
          bytes: Buffer.byteLength(content, 'utf-8'),
          lines: content.split('\n').length,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Failed to write file: ${message}` };
    }
  }

  private resolvePath(filePath: string, workspaceRoot: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(workspaceRoot, filePath);
  }
}
