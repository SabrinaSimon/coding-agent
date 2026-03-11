import * as vscode from 'vscode';
import { AgentCore } from './agent/AgentCore';
import { ToolRegistry } from './agent/ToolRegistry';
import { ContextManager } from './agent/ContextManager';
import { MemoryManager } from './memory/MemoryManager';
import { PermissionManager } from './permissions/PermissionManager';
import { ProviderFactory } from './llm/ProviderFactory';
import { ChatPanel } from './ui/ChatPanel';

let outputChannel: vscode.OutputChannel;
let agentCore: AgentCore | undefined;
let contextManager: ContextManager | undefined;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Coding Agent');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('[CodingAgent] Activating extension...');

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(robot) Coding Agent';
  statusBarItem.tooltip = 'Open Coding Agent';
  statusBarItem.command = 'codingAgent.openChat';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  // Initialize managers
  contextManager = new ContextManager(workspaceRoot);
  const memoryManager = new MemoryManager(workspaceRoot, context);
  const permissionManager = new PermissionManager(
    vscode.workspace.getConfiguration('codingAgent'),
  );
  const toolRegistry = new ToolRegistry();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codingAgent.openChat', async () => {
      try {
        const agent = await getOrCreateAgent(
          context, toolRegistry, permissionManager, memoryManager,
        );
        ChatPanel.createOrShow(context.extensionUri, agent, contextManager!, outputChannel);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const action = await vscode.window.showErrorMessage(
          `Coding Agent: ${msg}`,
          'Configure API Key',
        );
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
      vscode.window.showInformationMessage('Coding Agent: Started new session');
    }),

    vscode.commands.registerCommand('codingAgent.clearHistory', () => {
      agentCore?.clearHistory();
      vscode.window.showInformationMessage('Coding Agent: History cleared');
    }),

    vscode.commands.registerCommand('codingAgent.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection) return;

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const lang = editor.document.languageId;
      const prompt = `Explain this ${lang} code from \`${filePath}\`:\n\n\`\`\`${lang}\n${selection}\n\`\`\``;

      await openChatWithPrompt(context, toolRegistry, permissionManager, memoryManager, prompt);
    }),

    vscode.commands.registerCommand('codingAgent.fixSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection) return;

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const lang = editor.document.languageId;
      const prompt = `Fix any bugs or issues in this ${lang} code from \`${filePath}\`. Apply the fixes directly to the file:\n\n\`\`\`${lang}\n${selection}\n\`\`\``;

      await openChatWithPrompt(context, toolRegistry, permissionManager, memoryManager, prompt);
    }),

    vscode.commands.registerCommand('codingAgent.insertAtCursor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const lang = editor.document.languageId;
      const line = editor.selection.active.line + 1;

      const prompt = await vscode.window.showInputBox({
        prompt: 'What code should be inserted?',
        placeHolder: 'e.g. Add a function to validate email addresses',
      });
      if (!prompt) return;

      const fullPrompt = `In \`${filePath}\` at line ${line} (${lang} file), ${prompt}`;
      await openChatWithPrompt(context, toolRegistry, permissionManager, memoryManager, fullPrompt);
    }),
  );

  // Auto-index workspace on activation (background, non-blocking)
  contextManager.indexWorkspace().catch(() => {/* silent fail */});

  outputChannel.appendLine('[CodingAgent] Extension activated.');
}

async function getOrCreateAgent(
  context: vscode.ExtensionContext,
  toolRegistry: ToolRegistry,
  permissionManager: PermissionManager,
  memoryManager: MemoryManager,
): Promise<AgentCore> {
  if (agentCore) return agentCore;

  const provider = await ProviderFactory.create(context);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  agentCore = new AgentCore(
    provider,
    toolRegistry,
    permissionManager,
    memoryManager,
    context,
    outputChannel,
  );

  outputChannel.appendLine(`[CodingAgent] Agent created with provider: ${provider.name}`);
  return agentCore;
}

async function openChatWithPrompt(
  context: vscode.ExtensionContext,
  toolRegistry: ToolRegistry,
  permissionManager: PermissionManager,
  memoryManager: MemoryManager,
  prompt: string,
): Promise<void> {
  try {
    const agent = await getOrCreateAgent(context, toolRegistry, permissionManager, memoryManager);
    const panel = ChatPanel.createOrShow(context.extensionUri, agent, contextManager!, outputChannel);
    panel.sendTextToChat(prompt);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Coding Agent: ${msg}`);
  }
}

async function configureApiKey(context: vscode.ExtensionContext): Promise<void> {
  const providerChoice = await vscode.window.showQuickPick(
    [
      { label: 'Anthropic (Claude)', value: 'anthropic' },
      { label: 'OpenAI (GPT-4o)', value: 'openai' },
    ],
    { title: 'Select LLM Provider', placeHolder: 'Choose your AI provider' },
  );
  if (!providerChoice) return;

  const apiKey = await vscode.window.showInputBox({
    title: `Enter ${providerChoice.label} API Key`,
    placeHolder: 'sk-...',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => v.length < 10 ? 'API key seems too short' : null,
  });
  if (!apiKey) return;

  await ProviderFactory.storeApiKey(context, providerChoice.value, apiKey);

  // Update provider setting
  await vscode.workspace.getConfiguration('codingAgent').update(
    'provider',
    providerChoice.value,
    vscode.ConfigurationTarget.Global,
  );

  // Reset agent so it picks up the new key
  agentCore = undefined;

  vscode.window.showInformationMessage(
    `Coding Agent: API key saved for ${providerChoice.label}. You can now start chatting!`,
  );
}

export function deactivate(): void {
  outputChannel?.appendLine('[CodingAgent] Extension deactivated.');
  agentCore?.abort();
}
