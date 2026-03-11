import * as vscode from 'vscode';
import * as path from 'path';
import { AgentCore, AgentEvent } from '../agent/AgentCore';
import { ContextManager } from '../agent/ContextManager';
import { RepoConnectorRegistry, RepoConnection, RepoProvider } from '../integrations/RepoConnector';
import { JiraRegistry, JiraConnection, JiraFlavour } from '../integrations/jira/JiraConnector';

type WebviewMessage =
  // ── Chat tab ──
  | { type: 'sendMessage'; text: string }
  | { type: 'abort' }
  | { type: 'clearHistory' }
  // ── Documents tab ──
  | { type: 'uploadDocumentPicker' }
  | { type: 'removeDocument'; fileName: string }
  | { type: 'indexWorkspace' }
  // ── Repos tab ──
  | { type: 'addRepoConnection' }
  | { type: 'removeRepoConnection'; id: string }
  | { type: 'testRepoConnection'; id: string }
  // ── Jira tab ──
  | { type: 'addJiraConnection' }
  | { type: 'removeJiraConnection'; id: string }
  | { type: 'testJiraConnection'; id: string }
  // ── General ──
  | { type: 'openFile'; filePath: string }
  | { type: 'ready' };

export class ChatPanel {
  static currentPanel: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private isStreaming = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private agent: AgentCore,
    private contextManager: ContextManager,
    private repoRegistry: RepoConnectorRegistry,
    private jiraRegistry: JiraRegistry,
    private extensionUri: vscode.Uri,
    private outputChannel: vscode.OutputChannel,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      null,
      this.disposables,
    );
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    agent: AgentCore,
    contextManager: ContextManager,
    repoRegistry: RepoConnectorRegistry,
    jiraRegistry: JiraRegistry,
    outputChannel: vscode.OutputChannel,
  ): ChatPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal(column);
      return ChatPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'codingAgentChat',
      'Coding Agent',
      column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );

    ChatPanel.currentPanel = new ChatPanel(
      panel, agent, contextManager, repoRegistry, jiraRegistry, extensionUri, outputChannel,
    );
    return ChatPanel.currentPanel;
  }

  sendTextToChat(text: string): void {
    this.post({ type: 'prefillInput', text });
    this.panel.reveal();
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.syncAll();
        break;
      case 'sendMessage':
        await this.handleUserMessage(message.text);
        break;
      case 'abort':
        this.agent.abort();
        this.isStreaming = false;
        this.post({ type: 'streamEnd' });
        break;
      case 'clearHistory':
        this.agent.clearHistory();
        this.post({ type: 'historyCleared' });
        break;
      case 'uploadDocumentPicker':
        await this.pickAndUploadDocuments();
        break;
      case 'removeDocument':
        this.contextManager.removeUploadedDocument(message.fileName);
        await this.syncDocuments();
        break;
      case 'indexWorkspace':
        await this.indexWorkspace();
        break;
      case 'addRepoConnection':
        await this.addRepoConnection();
        break;
      case 'removeRepoConnection':
        this.repoRegistry.removeConnection(message.id);
        await this.syncRepos();
        break;
      case 'testRepoConnection':
        await this.testRepoConnection(message.id);
        break;
      case 'addJiraConnection':
        await this.addJiraConnection();
        break;
      case 'removeJiraConnection':
        this.jiraRegistry.removeConnection(message.id);
        await this.syncJira();
        break;
      case 'testJiraConnection':
        await this.testJiraConnection(message.id);
        break;
      case 'openFile':
        try { await vscode.window.showTextDocument(vscode.Uri.file(message.filePath)); } catch { }
        break;
    }
  }

  // ─── Chat ─────────────────────────────────────────────────────────────────

  private async handleUserMessage(text: string): Promise<void> {
    if (this.isStreaming) return;
    this.isStreaming = true;
    this.post({ type: 'streamStart' });
    try {
      await this.agent.chat(text, (event: AgentEvent) => {
        switch (event.type) {
          case 'text_delta':   this.post({ type: 'textDelta', text: event.text }); break;
          case 'tool_start':   this.post({ type: 'toolStart', tool: event.tool }); break;
          case 'tool_result':  this.post({ type: 'toolResult', tool: event.tool }); break;
          case 'tool_denied':  this.post({ type: 'toolDenied', tool: event.tool }); break;
          case 'error':        this.post({ type: 'error', error: event.error }); break;
          case 'done':         this.post({ type: 'streamEnd' }); break;
        }
      });
    } catch (err: unknown) {
      this.post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.isStreaming = false;
      this.post({ type: 'streamEnd' });
    }
  }

  // ─── Documents ────────────────────────────────────────────────────────────

  private async pickAndUploadDocuments(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: {
        'Documents': ['md', 'txt', 'pdf', 'docx', 'rst', 'json', 'yaml', 'yml'],
        'All Files': ['*'],
      },
      title: 'Upload documents to Coding Agent context',
    });
    if (!uris || !uris.length) return;

    for (const uri of uris) {
      this.post({ type: 'statusMessage', text: `Uploading ${path.basename(uri.fsPath)}...` });
      try {
        const chunk = await this.contextManager.uploadDocument(uri.fsPath);
        this.post({ type: 'statusMessage', text: `Uploaded: ${path.basename(uri.fsPath)} (${(chunk.size / 1024).toFixed(1)}KB)` });
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Upload failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    await this.syncDocuments();
  }

  private async indexWorkspace(): Promise<void> {
    this.post({ type: 'statusMessage', text: 'Indexing workspace...' });
    try {
      await this.contextManager.indexWorkspace(msg => this.post({ type: 'statusMessage', text: msg }));
      this.post({ type: 'statusMessage', text: 'Workspace indexed — agent now understands your codebase structure' });
    } catch (err: unknown) {
      this.post({ type: 'error', error: `Indexing failed: ${err instanceof Error ? err.message : err}` });
    }
  }

  // ─── Repo connections ─────────────────────────────────────────────────────

  private async addRepoConnection(): Promise<void> {
    const provider = await vscode.window.showQuickPick(
      [
        { label: '$(github) GitHub', value: 'github' as RepoProvider },
        { label: '$(git-merge) GitLab', value: 'gitlab' as RepoProvider },
        { label: '$(repo) Bitbucket', value: 'bitbucket' as RepoProvider },
      ],
      { title: 'Select repository provider' },
    );
    if (!provider) return;

    const repoLabel = await vscode.window.showInputBox({
      title: `${provider.label} — Repository`,
      placeHolder: 'owner/repository  (e.g. myorg/myrepo)',
      ignoreFocusOut: true,
      validateInput: v => v.includes('/') ? null : 'Must be in owner/repo format',
    });
    if (!repoLabel) return;

    const token = await vscode.window.showInputBox({
      title: `${provider.label} — Personal Access Token`,
      placeHolder: 'ghp_...  or  glpat-...  or  Bitbucket App Password',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return;

    let baseUrl: string | undefined;
    if (provider.value === 'gitlab') {
      baseUrl = await vscode.window.showInputBox({
        title: 'GitLab base URL (leave blank for gitlab.com)',
        placeHolder: 'https://gitlab.mycompany.com/api/v4',
        ignoreFocusOut: true,
      });
    }

    const id = `${provider.value}_${repoLabel.replace('/', '_')}_${Date.now()}`;
    const conn: RepoConnection = {
      id,
      provider: provider.value,
      label: repoLabel,
      baseUrl: baseUrl || '',
      token,
      defaultBranch: 'main',
    };

    this.repoRegistry.addConnection(conn);
    await this.syncRepos();

    this.post({ type: 'statusMessage', text: `Repository ${repoLabel} connected. Testing...` });
    const ok = await this.repoRegistry.testConnection(conn);
    this.post({
      type: 'statusMessage',
      text: ok ? `✓ ${repoLabel} connected successfully` : `⚠ Could not verify ${repoLabel} — check token and repo name`,
    });
    await this.syncRepos();
  }

  private async testRepoConnection(id: string): Promise<void> {
    const conn = this.repoRegistry.getConnection(id);
    if (!conn) return;
    this.post({ type: 'statusMessage', text: `Testing ${conn.label}...` });
    const ok = await this.repoRegistry.testConnection(conn);
    this.post({
      type: 'statusMessage',
      text: ok ? `✓ ${conn.label} is reachable` : `✗ ${conn.label} failed — check credentials`,
    });
  }

  // ─── Jira connections ─────────────────────────────────────────────────────

  private async addJiraConnection(): Promise<void> {
    const flavour = await vscode.window.showQuickPick(
      [
        { label: 'Jira Cloud (atlassian.net)', value: 'cloud' as JiraFlavour },
        { label: 'Jira Server / Data Center', value: 'server' as JiraFlavour },
      ],
      { title: 'Select Jira deployment type' },
    );
    if (!flavour) return;

    const baseUrl = await vscode.window.showInputBox({
      title: 'Jira Base URL',
      placeHolder: flavour.value === 'cloud'
        ? 'https://mycompany.atlassian.net'
        : 'https://jira.mycompany.com',
      ignoreFocusOut: true,
      validateInput: v => v.startsWith('http') ? null : 'Must be a valid URL',
    });
    if (!baseUrl) return;

    let email = '';
    if (flavour.value === 'cloud') {
      const input = await vscode.window.showInputBox({
        title: 'Jira Cloud — Account Email',
        placeHolder: 'you@company.com',
        ignoreFocusOut: true,
      });
      if (!input) return;
      email = input;
    }

    const token = await vscode.window.showInputBox({
      title: flavour.value === 'cloud' ? 'Jira API Token' : 'Jira Personal Access Token',
      placeHolder: flavour.value === 'cloud'
        ? 'Generate at id.atlassian.com/manage-profile/security/api-tokens'
        : 'PAT from User Settings → Personal Access Tokens',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return;

    const label = await vscode.window.showInputBox({
      title: 'Connection name',
      value: new URL(baseUrl).hostname,
      ignoreFocusOut: true,
    });
    if (!label) return;

    const id = `jira_${label.replace(/\W/g, '_')}_${Date.now()}`;
    const conn: JiraConnection = { id, label, baseUrl, email, token, flavour: flavour.value };

    this.jiraRegistry.addConnection(conn);

    this.post({ type: 'statusMessage', text: `Testing Jira connection to ${label}...` });
    const result = await this.jiraRegistry.connector.testConnection(conn);
    if (result.ok) {
      this.post({ type: 'statusMessage', text: `✓ Connected as ${result.user}` });
    } else {
      this.post({ type: 'statusMessage', text: `⚠ Connected but could not verify: ${result.error}` });
    }

    await this.syncJira();
  }

  private async testJiraConnection(id: string): Promise<void> {
    const conn = this.jiraRegistry.getConnection(id);
    if (!conn) return;
    const result = await this.jiraRegistry.connector.testConnection(conn);
    this.post({
      type: 'statusMessage',
      text: result.ok ? `✓ Jira: connected as ${result.user}` : `✗ Jira failed: ${result.error}`,
    });
  }

  // ─── Sync helpers ─────────────────────────────────────────────────────────

  private async syncAll(): Promise<void> {
    await Promise.all([this.syncDocuments(), this.syncRepos(), this.syncJira()]);
  }

  private async syncDocuments(): Promise<void> {
    const docs = this.contextManager.getUploadedDocuments().map(d => ({
      name: d.source.replace('uploaded:', ''),
      size: d.size,
      type: d.type,
    }));
    this.post({ type: 'documentList', documents: docs });

    const idx = this.contextManager.getIndex();
    if (idx) {
      this.post({
        type: 'indexStatus',
        stats: {
          files: idx.files.length,
          archDocs: idx.architectureDocs.length,
          businessRules: idx.businessRules.length,
          standards: idx.codingStandards.length,
        },
      });
    }
  }

  private async syncRepos(): Promise<void> {
    this.post({
      type: 'repoList',
      repos: this.repoRegistry.getConnections().map(c => ({
        id: c.id,
        label: c.label,
        provider: c.provider,
      })),
    });
  }

  private async syncJira(): Promise<void> {
    this.post({
      type: 'jiraList',
      connections: this.jiraRegistry.getConnections().map(c => ({
        id: c.id,
        label: c.label,
        flavour: c.flavour,
        baseUrl: c.baseUrl,
      })),
    });
  }

  private post(message: object): void {
    this.panel.webview.postMessage(message);
  }

  // ─── HTML ─────────────────────────────────────────────────────────────────

  private getHtml(): string {
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
        Math.floor(Math.random() * 62)
      ]
    ).join('');

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<title>Coding Agent</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column;height:100vh;overflow:hidden}

/* ── Tabs ── */
#tab-bar{display:flex;background:var(--vscode-titleBar-activeBackground);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
.tab{padding:8px 16px;cursor:pointer;font-size:12px;font-weight:500;border-bottom:2px solid transparent;opacity:.7;white-space:nowrap}
.tab:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
.tab.active{border-bottom-color:var(--vscode-focusBorder);opacity:1;color:var(--vscode-focusBorder)}
#status-bar{font-size:11px;color:var(--vscode-descriptionForeground);padding:3px 10px;border-bottom:1px solid var(--vscode-panel-border);min-height:22px;flex-shrink:0}

/* ── Tab panels ── */
.tab-panel{display:none;flex:1;flex-direction:column;overflow:hidden}
.tab-panel.active{display:flex}

/* ── Chat ── */
#messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:100%}
.msg .label{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:3px;font-weight:600}
.msg.user .bubble{background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:8px 8px 2px 8px;padding:8px 12px;margin-left:24px}
.msg.assistant .bubble{background:var(--vscode-editor-inactiveSelectionBackground);border-radius:2px 8px 8px 8px;padding:8px 12px}
.tool-call{font-size:11px;background:var(--vscode-terminal-background);border:1px solid var(--vscode-panel-border);border-radius:4px;padding:5px 9px;margin:3px 0;font-family:var(--vscode-editor-font-family,monospace);display:flex;justify-content:space-between;align-items:center}
.tool-call .tn{font-weight:bold;color:var(--vscode-symbolIcon-functionForeground)}
.tool-call .ta{color:var(--vscode-descriptionForeground);font-size:10px;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool-call.running .ts{color:var(--vscode-progressBar-background)}
.tool-call.ok .ts{color:#4ec9b0}
.tool-call.error .ts{color:#f48771}
.tool-call.denied .ts{color:#ce9178}
#input-area{padding:8px;border-top:1px solid var(--vscode-panel-border);flex-shrink:0}
#input-row{display:flex;gap:6px;align-items:flex-end}
#user-input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:8px;font-family:inherit;font-size:inherit;resize:none;min-height:56px;max-height:180px}
#user-input:focus{outline:1px solid var(--vscode-focusBorder)}
.btn{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:7px 14px;cursor:pointer;font-size:12px}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.btn-sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-sec:hover{background:var(--vscode-button-secondaryHoverBackground)}
.btn-danger{background:#c72e2e}
.hint{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px}
pre{background:var(--vscode-textCodeBlock-background);border-radius:4px;padding:10px;overflow-x:auto;font-size:12px}
code{font-family:var(--vscode-editor-font-family,monospace);font-size:12px}
p{margin:4px 0;line-height:1.5}
ul,ol{padding-left:18px}
.cursor{display:inline-block;width:2px;height:14px;background:currentColor;animation:blink .8s step-end infinite;vertical-align:text-bottom}
@keyframes blink{50%{opacity:0}}

/* ── Documents panel ── */
#docs-panel{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px}
.panel-section{background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px}
.panel-section h3{font-size:12px;font-weight:600;margin-bottom:8px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.5px}
.doc-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--vscode-panel-border)}
.doc-row:last-child{border-bottom:none}
.doc-icon{font-size:16px}
.doc-info{flex:1}
.doc-info .doc-name{font-size:12px;font-weight:500}
.doc-info .doc-meta{font-size:10px;color:var(--vscode-descriptionForeground)}
.btn-xs{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;padding:2px 7px;cursor:pointer;font-size:11px}
.btn-xs:hover{background:var(--vscode-button-secondaryHoverBackground)}
.btn-xs.remove{background:#c72e2e22;color:#f48771}
.index-stat{display:flex;gap:16px;flex-wrap:wrap}
.stat-chip{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:10px;padding:3px 10px;font-size:11px}
.empty-state{text-align:center;color:var(--vscode-descriptionForeground);font-size:12px;padding:20px 0}

/* ── Integrations panel ── */
#repos-panel,#jira-panel{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px}
.conn-row{display:flex;align-items:center;gap:8px;padding:8px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:5px}
.conn-info{flex:1}
.conn-name{font-size:12px;font-weight:600}
.conn-meta{font-size:10px;color:var(--vscode-descriptionForeground)}
.provider-badge{font-size:10px;border-radius:3px;padding:1px 6px;font-weight:600;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.add-btn-row{display:flex;justify-content:center;padding-top:4px}

/* Scrollbar */
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:3px}
</style>
</head>
<body>

<!-- ── Tab Bar ── -->
<div id="tab-bar">
  <div class="tab active" onclick="switchTab('chat')" id="tab-chat">💬 Chat</div>
  <div class="tab" onclick="switchTab('docs')" id="tab-docs">📎 Documents</div>
  <div class="tab" onclick="switchTab('repos')" id="tab-repos">🔗 Repositories</div>
  <div class="tab" onclick="switchTab('jira')" id="tab-jira">📋 Jira</div>
</div>
<div id="status-bar"></div>

<!-- ════════════════════════════════════════════════════════ CHAT TAB -->
<div class="tab-panel active" id="panel-chat">
  <div id="messages"></div>
  <div id="input-area">
    <div id="input-row">
      <textarea id="user-input" placeholder="Ask anything — build features, fix bugs, explain architecture, query Jira..." rows="3"></textarea>
      <div style="display:flex;flex-direction:column;gap:5px">
        <button class="btn" id="send-btn" onclick="sendMessage()">Send ↵</button>
        <button class="btn btn-danger" id="abort-btn" onclick="abort()" style="display:none">■ Stop</button>
        <button class="btn btn-sec" onclick="clearHistory()">🗑</button>
      </div>
    </div>
    <div class="hint">Ctrl+Enter to send · Agent can read/write code, run tests, query Jira & repos</div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════ DOCUMENTS TAB -->
<div class="tab-panel" id="panel-docs">
  <div id="docs-panel">

    <!-- Workspace index -->
    <div class="panel-section">
      <h3>Workspace Index</h3>
      <p style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:8px">
        Index your workspace so the agent understands the codebase structure, architecture docs, business rules, and coding standards automatically.
      </p>
      <div id="index-stats" class="index-stat" style="margin-bottom:10px">
        <span class="stat-chip">Not indexed</span>
      </div>
      <button class="btn btn-sec" onclick="indexWorkspace()">⚡ Index / Re-index Workspace</button>
    </div>

    <!-- Uploaded documents -->
    <div class="panel-section">
      <h3>Uploaded Reference Documents</h3>
      <p style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:8px">
        Upload PDFs, Word docs, Markdown, YAML — anything the agent should read as project context (architecture diagrams, API contracts, runbooks, business rules, etc.)
      </p>
      <div id="doc-list"></div>
      <div class="add-btn-row" style="justify-content:flex-start;padding-top:8px">
        <button class="btn btn-sec" onclick="uploadDocs()">📎 Upload Documents</button>
      </div>
    </div>

    <!-- Auto-discovered context summary -->
    <div class="panel-section">
      <h3>Auto-discovered Context</h3>
      <p style="font-size:12px;color:var(--vscode-descriptionForeground)">
        After indexing, the agent automatically discovers and injects:
      </p>
      <ul style="font-size:12px;color:var(--vscode-descriptionForeground);margin-top:6px;padding-left:16px">
        <li><strong>Architecture docs</strong> — ARCHITECTURE.md, ADR/**, docs/design/**</li>
        <li><strong>Business rules</strong> — REQUIREMENTS.md, docs/business/**, *.spec.md</li>
        <li><strong>Coding standards</strong> — .eslintrc, CONTRIBUTING.md, pyproject.toml</li>
        <li><strong>Project memory</strong> — AGENTS.md (persistent notes from past sessions)</li>
      </ul>
    </div>

  </div>
</div>

<!-- ════════════════════════════════════════════════════════ REPOSITORIES TAB -->
<div class="tab-panel" id="panel-repos">
  <div id="repos-panel">

    <div class="panel-section">
      <h3>Connected Repositories</h3>
      <p style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:10px">
        Connect GitHub, GitLab, or Bitbucket repos. The agent can then read files, list branches, inspect PRs, and search code in remote repos without cloning.
      </p>
      <div id="repo-list"><div class="empty-state">No repositories connected yet</div></div>
      <div class="add-btn-row" style="justify-content:flex-start;padding-top:10px">
        <button class="btn" onclick="addRepo()">＋ Connect Repository</button>
      </div>
    </div>

    <div class="panel-section">
      <h3>What the agent can do with connected repos</h3>
      <ul style="font-size:12px;color:var(--vscode-descriptionForeground);padding-left:16px">
        <li>Browse any branch or tag</li>
        <li>Read any file without cloning locally</li>
        <li>List and inspect pull requests</li>
        <li>View recent commit history</li>
        <li>Search code across the repository</li>
        <li>Understand how a remote service works to integrate with it</li>
      </ul>
    </div>

  </div>
</div>

<!-- ════════════════════════════════════════════════════════ JIRA TAB -->
<div class="tab-panel" id="panel-jira">
  <div id="jira-panel">

    <div class="panel-section">
      <h3>Connected Jira Instances</h3>
      <p style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:10px">
        Connect to any Jira Cloud or Jira Server/Data Center instance. The agent can read boards, sprints, and issue details including acceptance criteria and comments.
      </p>
      <div id="jira-list"><div class="empty-state">No Jira instances connected yet</div></div>
      <div class="add-btn-row" style="justify-content:flex-start;padding-top:10px">
        <button class="btn" onclick="addJira()">＋ Connect Jira</button>
      </div>
    </div>

    <div class="panel-section">
      <h3>What the agent can do with Jira</h3>
      <ul style="font-size:12px;color:var(--vscode-descriptionForeground);padding-left:16px">
        <li>List all projects, boards, and sprints</li>
        <li>Read any issue — description, acceptance criteria, comments, attachments</li>
        <li>Search issues with JQL (Jira Query Language)</li>
        <li>Implement a Jira story end-to-end: reads AC → writes code → runs tests</li>
        <li>Add comments to issues (e.g. "PR raised at ...")</li>
        <li>Create new issues (bugs, tasks, stories)</li>
        <li>Transition issue status (To Do → In Progress → Done)</li>
      </ul>
      <p style="font-size:12px;color:var(--vscode-descriptionForeground);margin-top:8px">
        <strong>Example prompt:</strong> <em>"Implement PROJ-123 based on the acceptance criteria"</em> — the agent fetches the issue, reads the AC, writes the code, runs tests, and updates the Jira status.
      </p>
    </div>

  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let currentMsg = null, currentText = '', isStreaming = false;

/* ── Tab switching ── */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('panel-' + name).classList.add('active');
}

/* ── Chat ── */
function sendMessage() {
  if (isStreaming) return;
  const el = document.getElementById('user-input');
  const text = el.value.trim();
  if (!text) return;
  el.value = '';
  appendUserMsg(text);
  vscode.postMessage({ type: 'sendMessage', text });
}
function abort() { vscode.postMessage({ type: 'abort' }); }
function clearHistory() { vscode.postMessage({ type: 'clearHistory' }); }

function appendUserMsg(text) {
  const el = mkMsg('user', esc(text));
  document.getElementById('messages').appendChild(el);
  scrollBottom();
}
function startAssistantMsg() {
  currentText = '';
  currentMsg = mkMsg('assistant', '');
  currentMsg.querySelector('.bubble').innerHTML = '<span class="cursor"></span>';
  document.getElementById('messages').appendChild(currentMsg);
  scrollBottom();
}
function appendDelta(text) {
  if (!currentMsg) startAssistantMsg();
  currentText += text;
  currentMsg.querySelector('.bubble').innerHTML = md(currentText) + '<span class="cursor"></span>';
  scrollBottom();
}
function finaliseMsg() {
  if (!currentMsg) return;
  currentMsg.querySelector('.bubble').innerHTML = md(currentText);
  currentMsg = null; currentText = '';
}
function appendTool(tool, status) {
  if (!currentMsg) startAssistantMsg();
  const bubble = currentMsg.querySelector('.bubble');
  const el = document.createElement('div');
  el.className = 'tool-call ' + (status || 'running');
  el.id = 'tc-' + tool.id;
  const args = tool.input ? Object.entries(tool.input)
    .map(([k,v]) => k+'='+JSON.stringify(String(v).slice(0,50))).join(', ') : '';
  el.innerHTML =
    '<span class="tn">' + esc(tool.name) + '</span>' +
    '<span class="ta">' + esc(args) + '</span>' +
    '<span class="ts">' + statusLabel(status) + '</span>';
  bubble.insertBefore(el, bubble.querySelector('.cursor'));
  scrollBottom();
}
function updateTool(id, status, duration) {
  const el = document.getElementById('tc-' + id);
  if (!el) return;
  el.className = 'tool-call ' + status;
  el.querySelector('.ts').textContent = statusLabel(status) + (duration ? ' ('+duration+'ms)' : '');
}
function statusLabel(s) {
  return s === 'running' ? '⟳ running' : s === 'ok' ? '✓' : s === 'error' ? '✗ error' : '⊘ denied';
}
function mkMsg(role, html) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.innerHTML = '<div class="label">' + (role === 'user' ? 'You' : '🤖 Coding Agent') + '</div><div class="bubble">' + html + '</div>';
  return el;
}

/* ── Documents ── */
function uploadDocs() { vscode.postMessage({ type: 'uploadDocumentPicker' }); }
function indexWorkspace() { vscode.postMessage({ type: 'indexWorkspace' }); }
function renderDocList(docs) {
  const el = document.getElementById('doc-list');
  if (!docs.length) { el.innerHTML = '<div class="empty-state">No documents uploaded yet</div>'; return; }
  el.innerHTML = docs.map(d => \`
    <div class="doc-row">
      <span class="doc-icon">\${d.type === 'code' ? '📄' : d.type === 'doc' ? '📝' : '⚙️'}</span>
      <div class="doc-info">
        <div class="doc-name">\${esc(d.name)}</div>
        <div class="doc-meta">\${(d.size/1024).toFixed(1)}KB · \${d.type}</div>
      </div>
      <button class="btn-xs remove" onclick="removeDoc('\${esc(d.name)}')">Remove</button>
    </div>\`).join('');
}
function removeDoc(name) { vscode.postMessage({ type: 'removeDocument', fileName: name }); }
function renderIndexStats(stats) {
  document.getElementById('index-stats').innerHTML =
    \`<span class="stat-chip">📁 \${stats.files} files</span>\` +
    \`<span class="stat-chip">🏗 \${stats.archDocs} arch docs</span>\` +
    \`<span class="stat-chip">📋 \${stats.businessRules} business rule docs</span>\` +
    \`<span class="stat-chip">⚙️ \${stats.standards} standard files</span>\`;
}

/* ── Repos ── */
function addRepo() { vscode.postMessage({ type: 'addRepoConnection' }); }
function renderRepoList(repos) {
  const el = document.getElementById('repo-list');
  if (!repos.length) { el.innerHTML = '<div class="empty-state">No repositories connected yet</div>'; return; }
  el.innerHTML = repos.map(r => \`
    <div class="conn-row">
      <div class="conn-info">
        <div class="conn-name">\${esc(r.label)}</div>
        <div class="conn-meta"><span class="provider-badge">\${r.provider.toUpperCase()}</span> ID: \${esc(r.id)}</div>
      </div>
      <button class="btn-xs" onclick="testRepo('\${esc(r.id)}')">Test</button>
      <button class="btn-xs remove" onclick="removeRepo('\${esc(r.id)}')">Remove</button>
    </div>\`).join('');
}
function removeRepo(id) { vscode.postMessage({ type: 'removeRepoConnection', id }); }
function testRepo(id) { vscode.postMessage({ type: 'testRepoConnection', id }); }

/* ── Jira ── */
function addJira() { vscode.postMessage({ type: 'addJiraConnection' }); }
function renderJiraList(conns) {
  const el = document.getElementById('jira-list');
  if (!conns.length) { el.innerHTML = '<div class="empty-state">No Jira instances connected yet</div>'; return; }
  el.innerHTML = conns.map(c => \`
    <div class="conn-row">
      <div class="conn-info">
        <div class="conn-name">\${esc(c.label)}</div>
        <div class="conn-meta"><span class="provider-badge">\${c.flavour.toUpperCase()}</span> \${esc(c.baseUrl)}</div>
      </div>
      <button class="btn-xs" onclick="testJira('\${esc(c.id)}')">Test</button>
      <button class="btn-xs remove" onclick="removeJira('\${esc(c.id)}')">Remove</button>
    </div>\`).join('');
}
function removeJira(id) { vscode.postMessage({ type: 'removeJiraConnection', id }); }
function testJira(id) { vscode.postMessage({ type: 'testJiraConnection', id }); }

/* ── VSCode message handler ── */
window.addEventListener('message', ev => {
  const m = ev.data;
  switch (m.type) {
    case 'streamStart':
      isStreaming = true;
      startAssistantMsg();
      document.getElementById('send-btn').style.display = 'none';
      document.getElementById('abort-btn').style.display = 'inline-block';
      break;
    case 'streamEnd':
      isStreaming = false;
      finaliseMsg();
      document.getElementById('send-btn').style.display = 'inline-block';
      document.getElementById('abort-btn').style.display = 'none';
      break;
    case 'textDelta':     appendDelta(m.text); break;
    case 'toolStart':     appendTool(m.tool, 'running'); break;
    case 'toolResult':    updateTool(m.tool.id, m.tool.success ? 'ok' : 'error', m.tool.duration); break;
    case 'toolDenied':    updateTool(m.tool.id, 'denied', null); break;
    case 'error':
      const e = document.createElement('div');
      e.style.cssText = 'color:#f48771;padding:8px;border:1px solid #f48771;border-radius:4px;margin:4px 0';
      e.textContent = '⚠ ' + m.error;
      document.getElementById('messages').appendChild(e);
      scrollBottom();
      break;
    case 'historyCleared':  document.getElementById('messages').innerHTML = ''; break;
    case 'statusMessage':   setStatus(m.text); break;
    case 'documentList':    renderDocList(m.documents); break;
    case 'indexStatus':     renderIndexStats(m.stats); break;
    case 'repoList':        renderRepoList(m.repos); break;
    case 'jiraList':        renderJiraList(m.connections); break;
    case 'prefillInput':
      document.getElementById('user-input').value = m.text;
      document.getElementById('user-input').focus();
      break;
  }
});

/* ── Helpers ── */
function setStatus(t) {
  document.getElementById('status-bar').textContent = t;
  clearTimeout(window._stTimer);
  window._stTimer = setTimeout(() => document.getElementById('status-bar').textContent = '', 6000);
}
function scrollBottom() {
  const el = document.getElementById('messages');
  el.scrollTop = el.scrollHeight;
}
function esc(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function md(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\`\`\`(\\w*)(\\n[\\s\\S]*?)\`\`\`/g,(_,l,b)=>'<pre><code>'+b.slice(1)+'</code></pre>')
    .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>')
    .replace(/^### (.+)$/gm,'<strong>$1</strong>')
    .replace(/^## (.+)$/gm,'<strong>$1</strong>')
    .replace(/^- (.+)$/gm,'<li>$1</li>')
    .replace(/\\n/g,'<br>');
}

document.getElementById('user-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendMessage(); }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }

  dispose(): void {
    ChatPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
