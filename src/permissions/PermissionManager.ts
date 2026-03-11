import * as vscode from 'vscode';
import { RiskLevel, BaseTool, ToolInput } from '../tools/base/Tool';

export enum PermissionDecision {
  ALLOW = 'allow',
  DENY = 'deny',
  ALLOW_SESSION = 'allow_session',  // remember for this session
}

interface SessionGrant {
  toolName: string;
  inputHash?: string; // if empty, grants all calls to this tool
}

/**
 * Central gatekeeper for all tool executions.
 *
 * Decision flow:
 *   1. SAFE risk → always allow (unless blocklisted)
 *   2. Setting codingAgent.autoApprove* → allow automatically
 *   3. Session grant exists → allow
 *   4. Otherwise → show VSCode input/quick-pick dialog
 */
export class PermissionManager {
  private sessionGrants: Set<string> = new Set();

  constructor(private config: vscode.WorkspaceConfiguration) {}

  async requestPermission(
    tool: BaseTool,
    input: ToolInput,
  ): Promise<PermissionDecision> {
    const riskLevel = 'getRiskLevel' in tool
      ? (tool as any).getRiskLevel(input)  // eslint-disable-line @typescript-eslint/no-explicit-any
      : tool.riskLevel;

    // Always allow safe operations
    if (riskLevel === RiskLevel.SAFE) {
      return PermissionDecision.ALLOW;
    }

    // Check auto-approve settings
    if (this.isAutoApproved(tool.name)) {
      return PermissionDecision.ALLOW;
    }

    // Check session grants
    const grantKey = this.grantKey(tool.name);
    if (this.sessionGrants.has(grantKey)) {
      return PermissionDecision.ALLOW;
    }

    // Show confirmation dialog
    return this.askUser(tool, input, riskLevel);
  }

  private isAutoApproved(toolName: string): boolean {
    const config = vscode.workspace.getConfiguration('codingAgent');

    if (toolName === 'read_file' && config.get<boolean>('autoApproveReads', true)) {
      return true;
    }
    if ((toolName === 'write_file' || toolName === 'edit_file') &&
        config.get<boolean>('autoApproveWrites', false)) {
      return true;
    }
    if (toolName === 'bash' && config.get<boolean>('autoApproveBash', false)) {
      return true;
    }
    return false;
  }

  private async askUser(
    tool: BaseTool,
    input: ToolInput,
    riskLevel: RiskLevel,
  ): Promise<PermissionDecision> {
    const summary = tool.summarize(input);
    const riskIcon = riskLevel === RiskLevel.DANGER ? '⚠️' : '🔶';
    const riskLabel = riskLevel === RiskLevel.DANGER ? 'DANGER' : 'CAUTION';

    const message = `${riskIcon} [${riskLabel}] Coding Agent wants to:\n${summary}`;

    const choices = [
      { label: '✅ Allow once', value: PermissionDecision.ALLOW },
      { label: '📌 Allow for this session', value: PermissionDecision.ALLOW_SESSION },
      { label: '❌ Deny', value: PermissionDecision.DENY },
    ];

    const selection = await vscode.window.showQuickPick(
      choices.map(c => c.label),
      {
        title: 'Coding Agent — Permission Required',
        placeHolder: message,
        ignoreFocusOut: true,
      },
    );

    if (!selection) return PermissionDecision.DENY;

    const decision = choices.find(c => c.label === selection)!.value;

    if (decision === PermissionDecision.ALLOW_SESSION) {
      this.sessionGrants.add(this.grantKey(tool.name));
      return PermissionDecision.ALLOW;
    }

    return decision;
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear();
  }

  private grantKey(toolName: string): string {
    return `tool:${toolName}`;
  }
}
