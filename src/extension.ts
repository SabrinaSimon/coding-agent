import * as vscode from 'vscode';
import { AgentCore } from './agent/AgentCore';
import { ToolRegistry } from './agent/ToolRegistry';
import { ContextManager } from './agent/ContextManager';
import { MemoryManager } from './memory/MemoryManager';
import { PermissionManager } from './permissions/PermissionManager';
import { ProviderFactory } from './llm/ProviderFactory';
import { ChatViewProvider, buildChatHtml } from './ui/ChatPanel';
import { RepoConnectorRegistry } from './integrations/RepoConnector';
import { JiraRegistry } from './integrations/jira/JiraConnector';

let outputChannel: vscode.OutputChannel;
let agentCore: AgentCore | undefined;
let contextManager: ContextManager;
let repoRegistry: RepoConnectorRegistry;
let jiraRegistry: JiraRegistry;
let statusBarItem: vscode.StatusBarItem;
let chatViewProvider: ChatViewProvider | undefined;

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

  // ── Sidebar WebviewView provider ──────────────────────────────────────────
  // Register eagerly so the activity bar view has content immediately.
  // The provider lazily initialises the agent on first message.

  const lazyProvider = new LazyViewProvider(
    context, memoryManager, permissionManager,
    contextManager, repoRegistry, jiraRegistry, outputChannel,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, lazyProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('codingAgent.openChat', async () => {
      // Focus the sidebar view — this triggers resolveWebviewView if not yet open
      await vscode.commands.executeCommand('workbench.view.extension.codingAgent');
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
      await openChatWithPrompt(`Explain this ${lang} code from \`${file}\`:\n\n\`\`\`${lang}\n${sel}\n\`\`\``);
    }),

    vscode.commands.registerCommand('codingAgent.fixSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return;
      const sel = editor.document.getText(editor.selection);
      const file = vscode.workspace.asRelativePath(editor.document.uri);
      const lang = editor.document.languageId;
      await openChatWithPrompt(`Fix any bugs or issues in this ${lang} code from \`${file}\`. Apply the fix directly to the file:\n\n\`\`\`${lang}\n${sel}\n\`\`\``);
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
      await openChatWithPrompt(`In \`${file}\` at line ${line} (${lang}): ${prompt}`);
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

async function openChatWithPrompt(prompt: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.view.extension.codingAgent');
    chatViewProvider?.sendTextToChat(prompt);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Coding Agent: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── LazyViewProvider ─────────────────────────────────────────────────────────
// Wraps ChatViewProvider so the agent is created only when the first message
// is sent, not at extension activation time (which avoids blocking startup).

class LazyViewProvider implements vscode.WebviewViewProvider {
  private inner?: ChatViewProvider;
  private currentView?: vscode.WebviewView;
  private initState: 'pending' | 'ok' | 'failed' = 'pending';
  private pendingError?: string;

  constructor(
    private context: vscode.ExtensionContext,
    private memoryManager: MemoryManager,
    private permissionManager: PermissionManager,
    private ctxMgr: ContextManager,
    private repos: RepoConnectorRegistry,
    private jira: JiraRegistry,
    private out: vscode.OutputChannel,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.out.appendLine('[CodingAgent] resolveWebviewView called');
    this.currentView = webviewView;

    // ① Set HTML and message handler SYNCHRONOUSLY so the panel renders and
    //    responds immediately — before the async agent init completes.
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
    ).join('');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = buildChatHtml(nonce);

    // ② Register message handler immediately — forwards to inner once ready.
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (this.inner) {
        this.inner.handleMessagePublic(msg);
        return;
      }
      // When the webview JS loads it sends 'ready'. Use this to (re)send any
      // stored error — the postMessage in initAsync may have raced the JS load.
      if (msg.type === 'ready') {
        if (this.initState === 'failed' && this.pendingError) {
          webviewView.webview.postMessage({ type: 'initError', error: this.pendingError });
        } else if (this.initState === 'pending') {
          webviewView.webview.postMessage({ type: 'initPending' });
        }
      } else if (msg.type === 'retryInit') {
        this.initState = 'pending';
        this.pendingError = undefined;
        this.initAsync(webviewView);
      } else if (msg.type === 'openConfigureApiKey') {
        vscode.commands.executeCommand('codingAgent.configureApiKey');
      }
    });

    webviewView.onDidDispose(() => {
      this.currentView = undefined;
    });

    // ③ Init agent in background — posts error into chat on failure
    this.initAsync(webviewView);
  }

  private async initAsync(webviewView: vscode.WebviewView): Promise<void> {
    if (this.inner) {
      // Already initialised (e.g. panel was hidden and re-shown)
      this.inner.setView(webviewView);
      return;
    }

    try {
      const agent = await getOrCreateAgent(this.context, this.memoryManager, this.permissionManager);
      this.inner = new ChatViewProvider(
        agent, this.ctxMgr, this.repos, this.jira,
        this.context.extensionUri, this.out,
      );
      chatViewProvider = this.inner;
      this.initState = 'ok';
      this.pendingError = undefined;
      this.out.appendLine('[CodingAgent] Agent initialised');
      // Hide any error banner and wire up the view
      webviewView.webview.postMessage({ type: 'initOk' });
      this.inner.setView(webviewView);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.out.appendLine(`[CodingAgent] Provider init error: ${msg}`);
      this.initState = 'failed';
      this.pendingError = msg;
      // Send error — also stored so it can be re-sent when webview 'ready' fires
      webviewView.webview.postMessage({ type: 'initError', error: msg });
    }
  }

  sendTextToChat(text: string): void {
    this.inner?.sendTextToChat(text);
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
