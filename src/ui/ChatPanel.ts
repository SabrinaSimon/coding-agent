import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentCore, AgentEvent } from '../agent/AgentCore';
import { ContextManager } from '../agent/ContextManager';

type WebviewMessage =
  | { type: 'sendMessage'; text: string }
  | { type: 'abort' }
  | { type: 'clearHistory' }
  | { type: 'uploadDocument'; filePath: string }
  | { type: 'removeDocument'; fileName: string }
  | { type: 'indexWorkspace' }
  | { type: 'openFile'; filePath: string }
  | { type: 'ready' };

/**
 * Manages the VSCode WebView panel that hosts the Coding Agent chat UI.
 */
export class ChatPanel {
  static currentPanel: ChatPanel | undefined;
  private static readonly viewType = 'codingAgentChat';

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private isStreaming = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private agent: AgentCore,
    private contextManager: ContextManager,
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
      ChatPanel.viewType,
      'Coding Agent',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    ChatPanel.currentPanel = new ChatPanel(
      panel, agent, contextManager, extensionUri, outputChannel,
    );
    return ChatPanel.currentPanel;
  }

  sendTextToChat(text: string): void {
    this.panel.webview.postMessage({ type: 'prefillInput', text });
    this.panel.reveal();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sendDocumentList();
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

      case 'uploadDocument':
        await this.handleDocumentUpload(message.filePath);
        break;

      case 'removeDocument':
        this.contextManager.removeUploadedDocument(message.fileName);
        await this.sendDocumentList();
        break;

      case 'indexWorkspace':
        await this.handleIndexWorkspace();
        break;

      case 'openFile':
        await this.openFileInEditor(message.filePath);
        break;
    }
  }

  private async handleUserMessage(text: string): Promise<void> {
    if (this.isStreaming) return;
    this.isStreaming = true;

    this.post({ type: 'streamStart' });

    try {
      await this.agent.chat(text, (event: AgentEvent) => {
        this.handleAgentEvent(event);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', error: message });
    } finally {
      this.isStreaming = false;
      this.post({ type: 'streamEnd' });
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.post({ type: 'textDelta', text: event.text });
        break;

      case 'tool_start':
        this.post({
          type: 'toolStart',
          tool: event.tool,
        });
        break;

      case 'tool_result':
        this.post({
          type: 'toolResult',
          tool: event.tool,
        });
        break;

      case 'tool_denied':
        this.post({
          type: 'toolDenied',
          tool: event.tool,
        });
        break;

      case 'error':
        this.post({ type: 'error', error: event.error });
        break;

      case 'done':
        this.post({ type: 'streamEnd' });
        break;
    }
  }

  private async handleDocumentUpload(filePath?: string): Promise<void> {
    let targetPath = filePath;

    if (!targetPath) {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: {
          'Documents': ['md', 'txt', 'pdf', 'docx', 'rst', 'json', 'yaml', 'yml'],
          'All Files': ['*'],
        },
        title: 'Select documents to upload to Coding Agent',
      });
      if (!uris || uris.length === 0) return;

      for (const uri of uris) {
        await this.uploadSingleDoc(uri.fsPath);
      }
      return;
    }

    await this.uploadSingleDoc(targetPath);
  }

  private async uploadSingleDoc(filePath: string): Promise<void> {
    try {
      this.post({ type: 'statusMessage', text: `Uploading ${path.basename(filePath)}...` });
      const chunk = await this.contextManager.uploadDocument(filePath);
      await this.sendDocumentList();
      this.post({
        type: 'statusMessage',
        text: `Uploaded: ${path.basename(filePath)} (${(chunk.size / 1024).toFixed(1)}KB)`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to upload document: ${message}`);
    }
  }

  private async handleIndexWorkspace(): Promise<void> {
    this.post({ type: 'statusMessage', text: 'Indexing workspace...' });
    try {
      await this.contextManager.indexWorkspace((msg) => {
        this.post({ type: 'statusMessage', text: msg });
      });
      this.post({ type: 'statusMessage', text: 'Workspace indexed successfully!' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', error: `Indexing failed: ${message}` });
    }
  }

  private async sendDocumentList(): Promise<void> {
    const docs = this.contextManager.getUploadedDocuments().map(d => ({
      name: d.source.replace('uploaded:', ''),
      size: d.size,
      type: d.type,
    }));
    this.post({ type: 'documentList', documents: docs });
  }

  private async openFileInEditor(filePath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      await vscode.window.showTextDocument(uri);
    } catch { /* ignore */ }
  }

  private post(message: object): void {
    this.panel.webview.postMessage(message);
  }

  private getHtml(): string {
    const nonce = this.getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <title>Coding Agent</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Toolbar ── */
    #toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--vscode-titleBar-activeBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    #toolbar button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #toolbar .title { font-weight: bold; font-size: 13px; flex: 1; }
    #status-bar {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      min-height: 20px;
      flex-shrink: 0;
    }

    /* ── Documents panel ── */
    #docs-panel {
      padding: 6px 10px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: none;
      flex-shrink: 0;
      max-height: 120px;
      overflow-y: auto;
    }
    #docs-panel.visible { display: block; }
    .doc-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px;
      padding: 2px 8px;
      font-size: 11px;
      margin: 2px;
    }
    .doc-chip .remove { cursor: pointer; opacity: 0.7; }
    .doc-chip .remove:hover { opacity: 1; }

    /* ── Messages ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .message { max-width: 100%; }
    .message.user .bubble {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 8px 8px 2px 8px;
      padding: 8px 12px;
      align-self: flex-end;
      margin-left: 20px;
    }
    .message.assistant .bubble {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 2px 8px 8px 8px;
      padding: 8px 12px;
    }
    .message .role-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      font-weight: 600;
    }

    /* ── Tool calls ── */
    .tool-call {
      font-size: 11px;
      background: var(--vscode-terminal-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 6px 10px;
      margin: 4px 0;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .tool-call .tool-name { font-weight: bold; color: var(--vscode-symbolIcon-functionForeground); }
    .tool-call .tool-status { float: right; }
    .tool-call.ok .tool-status { color: #4ec9b0; }
    .tool-call.error .tool-status { color: #f48771; }
    .tool-call.denied .tool-status { color: #ce9178; }
    .tool-call.running .tool-status { color: var(--vscode-progressBar-background); }

    /* ── Code blocks in markdown ── */
    pre {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      padding: 10px;
      overflow-x: auto;
      font-size: 12px;
    }
    code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    p { margin: 4px 0; line-height: 1.5; }
    ul, ol { padding-left: 18px; }

    /* ── Input area ── */
    #input-area {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      flex-shrink: 0;
    }
    #input-row { display: flex; gap: 6px; align-items: flex-end; }
    #user-input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-family: inherit;
      font-size: inherit;
      resize: none;
      min-height: 60px;
      max-height: 200px;
    }
    #user-input:focus { outline: 1px solid var(--vscode-focusBorder); }
    #send-btn, #abort-btn, #upload-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    #send-btn:hover { background: var(--vscode-button-hoverBackground); }
    #abort-btn { background: #c72e2e; display: none; }
    #upload-btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    #abort-btn.visible { display: inline-block; }
    #send-btn.hidden { display: none; }
    .hint { font-size: 10px; color: var(--vscode-descriptionForeground); }

    /* ── Streaming cursor ── */
    .cursor { display: inline-block; width: 2px; height: 14px; background: currentColor; animation: blink 0.8s step-end infinite; vertical-align: text-bottom; }
    @keyframes blink { 50% { opacity: 0; } }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
  </style>
</head>
<body>
  <div id="toolbar">
    <span class="title">🤖 Coding Agent</span>
    <button onclick="indexWorkspace()">Index Workspace</button>
    <button onclick="toggleDocs()">📎 Docs</button>
    <button onclick="clearHistory()">🗑 Clear</button>
  </div>
  <div id="status-bar"></div>
  <div id="docs-panel">
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:4px;">Uploaded documents (added to context):</div>
    <div id="doc-chips"></div>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <div id="input-row">
      <textarea id="user-input" placeholder="Ask anything about your code, ask to build features, fix bugs, or explain architecture..." rows="3"></textarea>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button id="send-btn" onclick="sendMessage()">Send ↵</button>
        <button id="abort-btn" onclick="abort()">■ Stop</button>
        <button id="upload-btn" onclick="uploadDoc()">📎 Upload</button>
      </div>
    </div>
    <div class="hint">Ctrl+Enter to send · Shift+Enter for new line · Coding Agent can read, write, and execute in your workspace</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentAssistantMsg = null;
    let currentTextContent = '';
    let isStreaming = false;

    // ── Message rendering ──────────────────────────────────────────────────────

    function appendUserMessage(text) {
      const msgEl = createMessageEl('user', escapeHtml(text));
      document.getElementById('messages').appendChild(msgEl);
      scrollToBottom();
    }

    function startAssistantMessage() {
      currentTextContent = '';
      currentAssistantMsg = createMessageEl('assistant', '');
      currentAssistantMsg.querySelector('.bubble').innerHTML = '<span class="cursor"></span>';
      document.getElementById('messages').appendChild(currentAssistantMsg);
      scrollToBottom();
    }

    function appendTextDelta(text) {
      if (!currentAssistantMsg) startAssistantMessage();
      currentTextContent += text;
      const bubble = currentAssistantMsg.querySelector('.bubble');
      bubble.innerHTML = renderMarkdown(currentTextContent) + '<span class="cursor"></span>';
      scrollToBottom();
    }

    function finalizeAssistantMessage() {
      if (currentAssistantMsg) {
        const bubble = currentAssistantMsg.querySelector('.bubble');
        bubble.innerHTML = renderMarkdown(currentTextContent);
        currentAssistantMsg = null;
        currentTextContent = '';
      }
    }

    function appendToolCall(tool, status, duration) {
      if (!currentAssistantMsg) startAssistantMessage();
      const bubble = currentAssistantMsg.querySelector('.bubble');
      const toolEl = document.createElement('div');
      toolEl.className = 'tool-call ' + (status || 'running');
      toolEl.id = 'tool-' + tool.id;
      const inputPreview = tool.input
        ? Object.entries(tool.input).map(([k,v]) =>
            k + '=' + JSON.stringify(String(v).slice(0,60))).join(', ')
        : '';
      const dur = duration ? ' (' + duration + 'ms)' : '';
      const statusText = status === 'running' ? '⟳ running' : status === 'ok' ? '✓' + dur : status === 'error' ? '✗' : '⊘ denied';
      toolEl.innerHTML =
        '<span class="tool-name">' + escapeHtml(tool.name) + '</span> ' +
        '<span style="color:var(--vscode-descriptionForeground);font-size:10px">' + escapeHtml(inputPreview) + '</span>' +
        '<span class="tool-status">' + statusText + '</span>';
      bubble.insertBefore(toolEl, bubble.querySelector('.cursor'));
      scrollToBottom();
    }

    function updateToolCall(toolId, status, duration) {
      const el = document.getElementById('tool-' + toolId);
      if (!el) return;
      el.className = 'tool-call ' + status;
      const statusEl = el.querySelector('.tool-status');
      const dur = duration ? ' (' + duration + 'ms)' : '';
      statusEl.textContent = status === 'ok' ? '✓' + dur : status === 'error' ? '✗ error' : '⊘ denied';
    }

    function createMessageEl(role, htmlContent) {
      const el = document.createElement('div');
      el.className = 'message ' + role;
      el.innerHTML =
        '<div class="role-label">' + (role === 'user' ? 'You' : '🤖 Coding Agent') + '</div>' +
        '<div class="bubble">' + htmlContent + '</div>';
      return el;
    }

    // ── Markdown renderer (minimal, no deps) ──────────────────────────────────

    function renderMarkdown(text) {
      return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        // Undo entity for code blocks we handle specially
        .replace(/\`\`\`(\\w*)(\\n[\\s\\S]*?\`\`\`)/g, (_, lang, body) => {
          return '<pre><code class="lang-' + lang + '">' + body.slice(1, -3) + '</code></pre>';
        })
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^#{3} (.+)$/gm, '<h3>$1</h3>')
        .replace(/^#{2} (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\\/li>)/s, '<ul>$1</ul>')
        .replace(/\\n\\n/g, '</p><p>')
        .replace(/^(.+)$/gm, (line) => line.startsWith('<') ? line : '<p>' + line + '</p>');
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    // ── VSCode message handler ─────────────────────────────────────────────────

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'streamStart':
          isStreaming = true;
          startAssistantMessage();
          document.getElementById('send-btn').classList.add('hidden');
          document.getElementById('abort-btn').classList.add('visible');
          break;

        case 'streamEnd':
          isStreaming = false;
          finalizeAssistantMessage();
          document.getElementById('send-btn').classList.remove('hidden');
          document.getElementById('abort-btn').classList.remove('visible');
          break;

        case 'textDelta':
          appendTextDelta(msg.text);
          break;

        case 'toolStart':
          appendToolCall(msg.tool, 'running', null);
          break;

        case 'toolResult':
          updateToolCall(msg.tool.id, msg.tool.success ? 'ok' : 'error', msg.tool.duration);
          break;

        case 'toolDenied':
          updateToolCall(msg.tool.id, 'denied', null);
          break;

        case 'error':
          const errEl = document.createElement('div');
          errEl.style.cssText = 'color:#f48771;padding:8px;border:1px solid #f48771;border-radius:4px;margin:4px 0;';
          errEl.textContent = '⚠ Error: ' + msg.error;
          document.getElementById('messages').appendChild(errEl);
          scrollToBottom();
          break;

        case 'historyCleared':
          document.getElementById('messages').innerHTML = '';
          setStatus('History cleared');
          break;

        case 'statusMessage':
          setStatus(msg.text);
          break;

        case 'documentList':
          renderDocumentList(msg.documents);
          break;

        case 'prefillInput':
          document.getElementById('user-input').value = msg.text;
          document.getElementById('user-input').focus();
          break;
      }
    });

    // ── Actions ───────────────────────────────────────────────────────────────

    function sendMessage() {
      if (isStreaming) return;
      const input = document.getElementById('user-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      appendUserMessage(text);
      vscode.postMessage({ type: 'sendMessage', text });
    }

    function abort() {
      vscode.postMessage({ type: 'abort' });
    }

    function clearHistory() {
      vscode.postMessage({ type: 'clearHistory' });
    }

    function uploadDoc() {
      vscode.postMessage({ type: 'uploadDocument' });
    }

    function indexWorkspace() {
      vscode.postMessage({ type: 'indexWorkspace' });
    }

    function toggleDocs() {
      const panel = document.getElementById('docs-panel');
      panel.classList.toggle('visible');
    }

    function setStatus(text) {
      document.getElementById('status-bar').textContent = text;
      setTimeout(() => { document.getElementById('status-bar').textContent = ''; }, 5000);
    }

    function renderDocumentList(docs) {
      const chips = document.getElementById('doc-chips');
      chips.innerHTML = docs.map(d =>
        '<span class="doc-chip">' +
          escapeHtml(d.name) + ' <small>(' + (d.size/1024).toFixed(0) + 'KB)</small>' +
          '<span class="remove" onclick="removeDoc(\\'' + escapeHtml(d.name) + '\\')">✕</span>' +
        '</span>'
      ).join('');
      if (docs.length > 0) {
        document.getElementById('docs-panel').classList.add('visible');
      }
    }

    function removeDoc(name) {
      vscode.postMessage({ type: 'removeDocument', fileName: name });
    }

    function scrollToBottom() {
      const msgs = document.getElementById('messages');
      msgs.scrollTop = msgs.scrollHeight;
    }

    // ── Keyboard shortcuts ────────────────────────────────────────────────────

    document.getElementById('user-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // ── Init ──────────────────────────────────────────────────────────────────

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
  }

  dispose(): void {
    ChatPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
