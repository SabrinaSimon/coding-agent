import { spawn } from 'child_process';
import { BaseTool, RiskLevel, ToolInput, ToolResult, ToolSchema, ToolContext } from '../base/Tool';

type GitOperation =
  | 'status' | 'diff' | 'log' | 'branch'
  | 'add' | 'commit' | 'push' | 'pull'
  | 'checkout' | 'stash' | 'reset';

interface GitInput extends ToolInput {
  operation: GitOperation;
  args?: string[];
}

const RISK_MAP: Record<GitOperation, RiskLevel> = {
  status:   RiskLevel.SAFE,
  diff:     RiskLevel.SAFE,
  log:      RiskLevel.SAFE,
  branch:   RiskLevel.SAFE,
  add:      RiskLevel.CAUTION,
  commit:   RiskLevel.CAUTION,
  stash:    RiskLevel.CAUTION,
  checkout: RiskLevel.CAUTION,
  reset:    RiskLevel.DANGER,
  push:     RiskLevel.DANGER,
  pull:     RiskLevel.DANGER,
};

export class GitTool extends BaseTool {
  readonly name = 'git';
  readonly description =
    'Execute a git operation on the repository. Supported operations: status, diff, log, branch, add, commit, push, pull, checkout, stash, reset. Always check status and diff before committing.';
  readonly riskLevel = RiskLevel.CAUTION; // Overridden per-call in permission check

  readonly schema: ToolSchema = {
    name: this.name,
    description: this.description,
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: Object.keys(RISK_MAP),
          description: 'The git operation to perform',
        },
        args: {
          type: 'array',
          description: 'Additional arguments for the git operation, e.g. ["-m", "fix: bug"]',
          items: { type: 'string', description: 'arg' },
        },
      },
      required: ['operation'],
    },
  };

  summarize(input: ToolInput): string {
    const g = input as GitInput;
    return `git ${g.operation}${g.args ? ' ' + g.args.join(' ') : ''}`;
  }

  getRiskLevel(input: ToolInput): RiskLevel {
    return RISK_MAP[(input as GitInput).operation] ?? RiskLevel.DANGER;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const { operation, args = [] } = input as GitInput;

    const safeArgs = this.sanitizeArgs(args);
    const command = ['git', operation, ...safeArgs];

    try {
      const { stdout, stderr, code } = await this.runGit(command, context.workspaceRoot);

      if (code !== 0 && !stdout && stderr) {
        return { success: false, output: '', error: stderr };
      }

      return {
        success: code === 0,
        output: stdout || stderr,
        error: code !== 0 ? stderr : undefined,
        metadata: { command: command.join(' '), exit_code: code },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Git failed: ${message}` };
    }
  }

  private sanitizeArgs(args: string[]): string[] {
    // Block force-push and other dangerous flags
    const BLOCKED = ['--force', '-f', '--hard', '--delete'];
    return args.filter(a => !BLOCKED.includes(a));
  }

  private runGit(command: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = command;
      const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

      proc.on('error', reject);
      proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    });
  }
}
