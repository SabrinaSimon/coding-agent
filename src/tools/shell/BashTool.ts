import { spawn } from 'child_process';
import { BaseTool, RiskLevel, ToolInput, ToolResult, ToolSchema, ToolContext } from '../base/Tool';

interface BashInput extends ToolInput {
  command: string;
  timeout?: number;
  cwd?: string;
  description?: string;
}

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/\s/,       // rm -rf /
  /mkfs\./,                  // format filesystem
  /dd\s+if=.*of=\/dev\//,   // overwrite device
  />\s*\/dev\/sd[a-z]/,     // overwrite disk
  /shutdown|reboot|halt/,   // system shutdown
  /fork\s*bomb/,            // fork bomb detection hint
  /:\(\)\s*\{.*\}/,         // fork bomb pattern
];

export class BashTool extends BaseTool {
  readonly name = 'bash';
  readonly description =
    'Execute a shell command in the workspace. Prefer specific tools (read_file, grep, etc.) when available. Use this for running tests, building, installing packages, git operations, and other terminal tasks. Commands have a default 2-minute timeout.';
  readonly riskLevel = RiskLevel.DANGER;

  readonly schema: ToolSchema = {
    name: this.name,
    description: this.description,
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds. Default: 120000 (2 minutes). Max: 600000 (10 minutes)',
        },
        cwd: {
          type: 'string',
          description: 'Working directory. Defaults to workspace root.',
        },
        description: {
          type: 'string',
          description: 'A short description of what this command does (for approval prompts)',
        },
      },
      required: ['command'],
    },
  };

  summarize(input: ToolInput): string {
    const b = input as BashInput;
    return b.description
      ? `Run: ${b.description} — \`${b.command}\``
      : `Run: \`${b.command}\``;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const {
      command,
      timeout = 120_000,
      cwd,
    } = input as BashInput;

    // Safety: block destructive patterns even if user approved
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return {
          success: false,
          output: '',
          error: `Command blocked by safety policy: matches dangerous pattern ${pattern}`,
        };
      }
    }

    const actualCwd = cwd || context.workspaceRoot;
    const actualTimeout = Math.min(timeout, 600_000);

    try {
      const result = await this.runCommand(command, actualCwd, actualTimeout, context.signal);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Command failed: ${message}` };
    }
  }

  private runCommand(
    command: string,
    cwd: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return new Promise((resolve) => {
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd' : 'bash';
      const shellFlag = isWindows ? '/c' : '-c';

      const proc = spawn(shell, [shellFlag, command], {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      const MAX_OUTPUT = 100_000; // 100KB cap

      proc.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({
          success: false,
          output: stdout,
          error: `Command timed out after ${timeout}ms\n${stderr}`,
        });
      }, timeout);

      if (signal) {
        signal.addEventListener('abort', () => {
          proc.kill('SIGTERM');
          clearTimeout(timer);
          resolve({ success: false, output: stdout, error: 'Aborted by user' });
        });
      }

      proc.on('close', (code) => {
        clearTimeout(timer);
        const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');
        resolve({
          success: code === 0,
          output: combinedOutput,
          error: code !== 0 ? `Process exited with code ${code}` : undefined,
          metadata: { exit_code: code },
        });
      });
    });
  }
}
