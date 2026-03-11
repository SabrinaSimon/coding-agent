import * as fs from 'fs/promises';
import * as path from 'path';
import { BaseTool, RiskLevel, ToolInput, ToolResult, ToolSchema, ToolContext } from '../base/Tool';

interface EditInput extends ToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export class EditTool extends BaseTool {
  readonly name = 'edit_file';
  readonly description =
    'Perform an exact string replacement in a file. The old_string must match the file exactly (including whitespace and indentation). The edit fails if old_string is not found or is ambiguous. Use replace_all to rename all occurrences.';
  readonly riskLevel = RiskLevel.DANGER;

  readonly schema: ToolSchema = {
    name: this.name,
    description: this.description,
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to edit',
        },
        old_string: {
          type: 'string',
          description: 'The exact text to find and replace. Must be unique in the file unless replace_all is true.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text',
        },
        replace_all: {
          type: 'boolean',  // eslint-disable-line @typescript-eslint/no-explicit-any
          description: 'Replace every occurrence of old_string (default: false)',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  };

  summarize(input: ToolInput): string {
    const { file_path, old_string } = input as EditInput;
    const preview = old_string.slice(0, 60).replace(/\n/g, '↵');
    return `Edit ${file_path}: replace "${preview}..."`;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const { file_path, old_string, new_string, replace_all = false } = input as EditInput;
    const resolved = this.resolvePath(file_path, context.workspaceRoot);

    try {
      const original = await fs.readFile(resolved, 'utf-8');

      const occurrences = this.countOccurrences(original, old_string);

      if (occurrences === 0) {
        return {
          success: false,
          output: '',
          error: `old_string not found in ${file_path}. Make sure whitespace and indentation are exact.`,
        };
      }

      if (occurrences > 1 && !replace_all) {
        return {
          success: false,
          output: '',
          error: `old_string appears ${occurrences} times in ${file_path}. Provide more context to make it unique, or set replace_all=true to replace all occurrences.`,
        };
      }

      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.replace(old_string, new_string);

      await fs.writeFile(resolved, updated, 'utf-8');

      const replacedCount = replace_all ? occurrences : 1;

      return {
        success: true,
        output: `Replaced ${replacedCount} occurrence(s) in ${file_path}`,
        metadata: { path: resolved, replaced_count: replacedCount },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Failed to edit file: ${message}` };
    }
  }

  private countOccurrences(text: string, search: string): number {
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(search, pos)) !== -1) {
      count++;
      pos += search.length;
    }
    return count;
  }

  private resolvePath(filePath: string, workspaceRoot: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(workspaceRoot, filePath);
  }
}
