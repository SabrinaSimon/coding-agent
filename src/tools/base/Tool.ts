import * as vscode from 'vscode';

/**
 * Risk level determines whether a tool needs user approval before execution.
 * SAFE    → auto-allowed (reads, searches)
 * CAUTION → prompt once per session
 * DANGER  → always prompt (writes, shell exec, git push)
 */
export enum RiskLevel {
  SAFE = 'safe',
  CAUTION = 'caution',
  DANGER = 'danger',
}

export interface ToolInput {
  [key: string]: unknown;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * JSON-Schema style parameter definition (subset used by Anthropic tool_use).
 */
export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

/**
 * Base class every tool must extend.
 */
export abstract class BaseTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly riskLevel: RiskLevel;
  abstract readonly schema: ToolSchema;

  /** Execute the tool.  Must be implemented by every concrete tool. */
  abstract execute(input: ToolInput, context: ToolContext): Promise<ToolResult>;

  /** Human-readable summary of what the tool call WILL do (for approval prompts). */
  abstract summarize(input: ToolInput): string;

  toAnthropicSchema(): ToolSchema {
    return this.schema;
  }

  toOpenAISchema(): object {
    const { name, description, input_schema } = this.schema;
    return {
      type: 'function',
      function: { name, description, parameters: input_schema },
    };
  }
}

/**
 * Runtime context passed to every tool on execution.
 */
export interface ToolContext {
  workspaceRoot: string;
  extensionContext: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  /** Absolute path of the currently active file (if any). */
  activeFile?: string;
  /** Abort signal — tools should honour this for long operations. */
  signal?: AbortSignal;
}
