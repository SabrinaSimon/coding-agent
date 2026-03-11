import * as fs from 'fs/promises';
import * as path from 'path';
import { BaseTool, RiskLevel, ToolInput, ToolResult, ToolSchema, ToolContext } from '../base/Tool';

interface GrepInput extends ToolInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  context?: number;
  case_insensitive?: boolean;
  head_limit?: number;
}

export class GrepTool extends BaseTool {
  readonly name = 'grep';
  readonly description =
    'Search for a regex pattern in file contents. Supports context lines, glob filtering, and multiple output modes. Much faster than reading each file individually.';
  readonly riskLevel = RiskLevel.SAFE;

  readonly schema: ToolSchema = {
    name: this.name,
    description: this.description,
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression to search for',
        },
        path: {
          type: 'string',
          description: 'Directory or file to search in. Defaults to workspace root.',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files, e.g. "*.ts" or "**/*.{js,ts}"',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'content: show matching lines. files_with_matches: show file paths only. count: show match counts.',
        },
        context: {
          type: 'number',
          description: 'Number of lines of context to show around each match (output_mode: content only)',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Case-insensitive matching (default: false)',
        },
        head_limit: {
          type: 'number',
          description: 'Limit output to first N lines/entries. Default: 200',
        },
      },
      required: ['pattern'],
    },
  };

  summarize(input: ToolInput): string {
    const g = input as GrepInput;
    return `Grep: "${g.pattern}" in ${g.path || 'workspace'}${g.glob ? ` [${g.glob}]` : ''}`;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const {
      pattern,
      path: searchPath,
      glob: globFilter,
      output_mode = 'files_with_matches',
      context: contextLines = 0,
      case_insensitive = false,
      head_limit = 200,
    } = input as GrepInput;

    const rootDir = searchPath
      ? this.resolvePath(searchPath, context.workspaceRoot)
      : context.workspaceRoot;

    try {
      const regex = new RegExp(pattern, case_insensitive ? 'gi' : 'g');
      const files = await this.collectFiles(rootDir, globFilter);

      const outputLines: string[] = [];
      let totalMatches = 0;

      for (const file of files) {
        if (outputLines.length >= head_limit) break;

        const content = await fs.readFile(file, 'utf-8').catch(() => null);
        if (content === null) continue;

        const lines = content.split('\n');
        const matchedLineNumbers: number[] = [];

        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            matchedLineNumbers.push(i);
            totalMatches++;
          }
        }

        if (matchedLineNumbers.length === 0) continue;

        if (output_mode === 'files_with_matches') {
          outputLines.push(file);
        } else if (output_mode === 'count') {
          outputLines.push(`${matchedLineNumbers.length}:${file}`);
        } else {
          // content mode with optional context
          const shown = new Set<number>();
          for (const ln of matchedLineNumbers) {
            const start = Math.max(0, ln - contextLines);
            const end = Math.min(lines.length - 1, ln + contextLines);
            for (let i = start; i <= end; i++) shown.add(i);
          }
          const separator = outputLines.length > 0 ? '--' : null;
          if (separator) outputLines.push(separator);
          for (const i of [...shown].sort((a, b) => a - b)) {
            const marker = matchedLineNumbers.includes(i) ? ':' : '-';
            outputLines.push(`${file}:${i + 1}${marker}${lines[i]}`);
            if (outputLines.length >= head_limit) break;
          }
        }
      }

      return {
        success: true,
        output: outputLines.join('\n'),
        metadata: {
          total_matches: totalMatches,
          files_searched: files.length,
          output_mode,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Grep failed: ${message}` };
    }
  }

  private async collectFiles(rootDir: string, globFilter?: string): Promise<string[]> {
    const files: string[] = [];
    await this.walkDir(rootDir, rootDir, globFilter, files);
    return files;
  }

  private async walkDir(
    baseDir: string,
    dir: string,
    globFilter: string | undefined,
    results: string[],
  ): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (['node_modules', 'dist', '.git', '__pycache__', '.next', 'build'].includes(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.walkDir(baseDir, fullPath, globFilter, results);
      } else {
        if (globFilter) {
          const mm = await import('micromatch');
          const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          if (mm.default([rel], globFilter).length === 0) continue;
        }
        results.push(fullPath);
      }
    }
  }

  private resolvePath(filePath: string, workspaceRoot: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(workspaceRoot, filePath);
  }
}
