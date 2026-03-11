import * as vscode from 'vscode';
import { AgentCore } from './agent/AgentCore';
import { ToolRegistry } from './agent/ToolRegistry';
import { ContextManager } from './agent/ContextManager';
import { MemoryManager } from './memory/MemoryManager';
import { PermissionManager } from './permissions/PermissionManager';
import { ProviderFactory } from './llm/ProviderFactory';
import { ChatPanel } from './ui/ChatPanel';
import { RepoConnectorRegistry } from './integrations/RepoConnector';
import { JiraRegistry } from './integrations/jira/JiraConnector';

let outputChannel: vscode.OutputChannel;
let agentCore: AgentCore | undefined;
let contextManager: ContextManager;
let repoRegistry: RepoConnectorRegistry;
let jiraRegistry: JiraRegistry;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Coding Agent');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('[CodingAgent] Activating...');

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(robot) Coding Agent';
  statusBarItem.tooltip = 'Open Coding Agent (Ctrl+Shift+A)';
  statusBarItem.command = 'codingAgent.openChat';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  // Shared singletons
  contextManager = new ContextManager(workspaceRoot);
  repoRegistry = new RepoConnectorRegistry();
  jiraRegistry = new JiraRegistry();

  const memoryManager = new MemoryManager(workspaceRoot, context);
  const permissionManager = new PermissionManager(
    vscode.workspace.getConfiguration('codingAgent'),
  );

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('codingAgent.openChat', async () => {
      try {
        const agent = await getOrCreateAgent(context, memoryManager, permissionManager);
        ChatPanel.createOrShow(
          context.extensionUri, agent, contextManager,
          repoRegistry, jiraRegistry, outputChannel,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const action = await vscode.window.showErrorMessage(`Coding Agent: ${msg}`, 'Configure API Key');
        if (action === 'Configure API Key') {
          await vscode.commands.executeCommand('codingAgent.configureApiKey');
        }
      }
    }),

    vscode.commands.registerCommand('codingAgent.configureApiKey', async () => {
      await configureApiKey(context);
    }),

    vscode.commands.registerCommand('codingAgent.newSession', () => {
      agentCore?.clearHistory();
      permissionManager.clearSessionGrants();
      vscode.window.showInformationMessage('Coding Agent: New session started');
    }),

    vscode.commands.registerCommand('codingAgent.clearHistory', () => {
      agentCore?.clearHistory();
    }),

    vscode.commands.registerCommand('codingAgent.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const sel = editor.document.getText(editor.selection);
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      const lang = editor.document.languageId;
      await openChatWithPrompt(
        context, memoryManager, permissionManager,
        `Explain this ${lang} code from \`${file}\`:\n\n\`\`\`${lang}\n${sel}\n\`\`\``,
      );
    }),

    vscode.commands.registerCommand('codingAgent.fixSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const sel = editor.document.getText(editor.selection);
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      const lang = editor.document.languageId;
      await openChatWithPrompt(
        context, memoryManager, permissionManager,
        `Fix any bugs or issues in this ${lang} code from \`${file}\`. Apply the fix directly to the file:\n\n\`\`\`${lang}\n${sel}\n\`\`\``,
      );
    }),

    vscode.commands.registerCommand('codingAgent.insertAtCursor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      const lang = editor.document.languageId;
      const line = editor.selection.active.line + 1;
      const prompt = await vscode.window.showInputBox({
        prompt: 'What code should be inserted?',
        placeHolder: 'e.g. Add input validation for the email field',
      });
      if (!prompt) return;
      await openChatWithPrompt(
        context, memoryManager, permissionManager,
        `In \`${file}\` at line ${line} (${lang}): ${prompt}`,
      );
    }),
  );

  // Background: index workspace silently on startup
  contextManager.indexWorkspace().catch(() => { /* silent */ });
  outputChannel.appendLine('[CodingAgent] Activated.');
}

// ─── Agent factory ────────────────────────────────────────────────────────────

async function getOrCreateAgent(
  context: vscode.ExtensionContext,
  memoryManager: MemoryManager,
  permissionManager: PermissionManager,
): Promise<AgentCore> {
  if (agentCore) return agentCore;

  const provider = await ProviderFactory.create(context);

  const toolRegistry = new ToolRegistry(repoRegistry, jiraRegistry);

  agentCore = new AgentCore(
    provider, toolRegistry, permissionManager,
    memoryManager, context, outputChannel,
  );

  outputChannel.appendLine(`[CodingAgent] Agent ready — provider: ${provider.name}`);
  return agentCore;
}

async function openChatWithPrompt(
  context: vscode.ExtensionContext,
  memoryManager: MemoryManager,
  permissionManager: PermissionManager,
  prompt: string,
): Promise<void> {
  try {
    const agent = await getOrCreateAgent(context, memoryManager, permissionManager);
    const panel = ChatPanel.createOrShow(
      context.extensionUri, agent, contextManager,
      repoRegistry, jiraRegistry, outputChannel,
    );
    panel.sendTextToChat(prompt);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Coding Agent: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── API key configuration (multi-provider picker) ───────────────────────────

async function configureApiKey(context: vscode.ExtensionContext): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(copilot) Use GitHub Copilot (no API key needed)',
        detail: 'Uses your existing Copilot subscription via the VSCode Language Model API',
        value: 'copilot',
      },
      {
        label: '$(cloud) Anthropic — Claude',
        detail: 'claude-sonnet-4-6, claude-opus-4-6, etc.',
        value: 'anthropic',
      },
      {
        label: '$(cloud) OpenAI — GPT-4o',
        detail: 'gpt-4o, gpt-4-turbo, etc.',
        value: 'openai',
      },
    ],
    { title: 'Coding Agent — Select AI Provider', matchOnDetail: true },
  );
  if (!choice) return;

  if (choice.value === 'copilot') {
    await vscode.workspace.getConfiguration('codingAgent').update(
      'provider', 'copilot', vscode.ConfigurationTarget.Global,
    );
    agentCore = undefined; // force recreation with new provider
    vscode.window.showInformationMessage(
      'Coding Agent will now use GitHub Copilot as the AI backend. No API key needed!',
    );
    return;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `Enter ${choice.label.replace(/^\$\([^)]+\) /, '')} API Key`,
    placeHolder: 'sk-...',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (!v || v.length < 10) ? 'API key seems too short' : null,
  });
  if (!apiKey) return;

  await ProviderFactory.storeApiKey(context, choice.value, apiKey);
  await vscode.workspace.getConfiguration('codingAgent').update(
    'provider', choice.value, vscode.ConfigurationTarget.Global,
  );

  agentCore = undefined;
  vscode.window.showInformationMessage(
    `Coding Agent: API key saved. Provider set to ${choice.label.replace(/^\$\([^)]+\) /, '')}.`,
  );
}

export function deactivate(): void {
  outputChannel?.appendLine('[CodingAgent] Deactivated.');
  agentCore?.abort();
}
