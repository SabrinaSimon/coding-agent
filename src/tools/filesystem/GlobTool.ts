import * as path from 'path';
import * as fs from 'fs/promises';
import { BaseTool, RiskLevel, ToolInput, ToolResult, ToolSchema, ToolContext } from '../base/Tool';

interface GlobInput extends ToolInput {
  pattern: string;
  path?: string;
  head_limit?: number;
}

export class GlobTool extends BaseTool {
  readonly name = 'glob';
  readonly description =
    'Find files matching a glob pattern. Returns matching file paths sorted by modification time. Supports patterns like "**/*.ts", "src/**/*.{js,ts}", etc.';
  readonly riskLevel = RiskLevel.SAFE;

  readonly schema: ToolSchema = {
    name: this.name,
    description: this.description,
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match, e.g. "**/*.ts" or "src/**/*.{js,jsx}"',
        },
        path: {
          type: 'string',
          description: 'Root directory to search from. Defaults to workspace root.',
        },
        head_limit: {
          type: 'number',
          description: 'Maximum number of results to return. Default: 100',
        },
      },
      required: ['pattern'],
    },
  };

  summarize(input: ToolInput): string {
    const g = input as GlobInput;
    return `Glob: ${g.pattern} in ${g.path || 'workspace root'}`;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const { pattern, path: searchPath, head_limit = 100 } = input as GlobInput;
    const rootDir = searchPath
      ? this.resolvePath(searchPath, context.workspaceRoot)
      : context.workspaceRoot;

    try {
      const files = await this.walkGlob(rootDir, pattern);
      const limited = files.slice(0, head_limit);

      return {
        success: true,
        output: limited.join('\n'),
        metadata: {
          total_matches: files.length,
          returned: limited.length,
          pattern,
          root: rootDir,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Glob failed: ${message}` };
    }
  }

  private async walkGlob(root: string, pattern: string): Promise<string[]> {
    // Use micromatch-style matching via manual walk
    const micromatch = await import('micromatch');
    const results: { file: string; mtime: number }[] = [];

    await this.walk(root, root, micromatch.default, pattern, results);

    return results
      .sort((a, b) => b.mtime - a.mtime)
      .map(r => r.file);
  }

  private async walk(
    baseDir: string,
    dir: string,
    mm: typeof import('micromatch').default,
    pattern: string,
    results: { file: string; mtime: number }[],
  ): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(baseDir, fullPath).replace(/\\/g, '/');

      // Skip hidden directories and common noise dirs
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      if (['node_modules', 'dist', '.git', '__pycache__', '.next'].includes(entry.name)) continue;

      if (entry.isDirectory()) {
        await this.walk(baseDir, fullPath, mm, pattern, results);
      } else {
        if (mm([relative], pattern).length > 0) {
          try {
            const stat = await fs.stat(fullPath);
            results.push({ file: fullPath, mtime: stat.mtimeMs });
          } catch {
            results.push({ file: fullPath, mtime: 0 });
          }
        }
      }
    }
  }

  private resolvePath(filePath: string, workspaceRoot: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(workspaceRoot, filePath);
  }
}
