/**
 * JiraConnector — connects to any Jira Cloud or Jira Server / Data Center instance.
 *
 * Uses Jira REST API v3 (Cloud) and v2 (Server).
 * Supports: projects, boards, sprints, issues, comments, attachments.
 */

export type JiraFlavour = 'cloud' | 'server';

export interface JiraConnection {
  id: string;
  label: string;          // e.g. "ACME Jira"
  baseUrl: string;        // e.g. "https://mycompany.atlassian.net"
  email: string;          // for Cloud: account email
  token: string;          // API token (Cloud) or PAT (Server)
  flavour: JiraFlavour;
}

export interface JiraProject {
  key: string;
  id: string;
  name: string;
  type: string;
  leadName?: string;
  url: string;
}

export interface JiraBoard {
  id: number;
  name: string;
  type: 'scrum' | 'kanban' | string;
  projectKey?: string;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: 'active' | 'closed' | 'future';
  startDate?: string;
  endDate?: string;
  goal?: string;
}

export interface JiraIssue {
  key: string;
  id: string;
  summary: string;
  description: string;
  type: string;           // Bug, Story, Task, Epic, etc.
  status: string;         // To Do, In Progress, Done, etc.
  priority: string;
  assignee?: string;
  reporter?: string;
  labels: string[];
  components: string[];
  sprint?: string;
  storyPoints?: number;
  created: string;
  updated: string;
  url: string;
  comments: JiraComment[];
  attachments: JiraAttachment[];
  linkedIssues: LinkedIssue[];
}

export interface JiraComment {
  id: string;
  author: string;
  body: string;
  created: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface LinkedIssue {
  key: string;
  summary: string;
  type: string;
  linkType: string;
}

export interface JiraSearchResult {
  total: number;
  issues: JiraIssue[];
}

export class JiraConnector {
  private async request<T>(
    conn: JiraConnection,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    const apiVersion = conn.flavour === 'cloud' ? '3' : '2';
    const url = `${conn.baseUrl}/rest/api/${apiVersion}${path}`;

    const auth =
      conn.flavour === 'cloud'
        ? `Basic ${Buffer.from(`${conn.email}:${conn.token}`).toString('base64')}`
        : `Bearer ${conn.token}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jira API ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }

    return res.json() as Promise<T>;
  }

  private async agileRequest<T>(
    conn: JiraConnection,
    path: string,
  ): Promise<T> {
    const url = `${conn.baseUrl}/rest/agile/1.0${path}`;
    const auth =
      conn.flavour === 'cloud'
        ? `Basic ${Buffer.from(`${conn.email}:${conn.token}`).toString('base64')}`
        : `Bearer ${conn.token}`;

    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Jira Agile API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  async listProjects(conn: JiraConnection): Promise<JiraProject[]> {
    const data = await this.request<{ values?: any[]; [k: string]: any }>(
      conn, '/project/search?maxResults=100'
    );
    const list: any[] = data.values || (Array.isArray(data) ? data : []);
    return list.map(p => ({
      key: p.key,
      id: p.id,
      name: p.name,
      type: p.projectTypeKey || p.style || 'classic',
      leadName: p.lead?.displayName,
      url: `${conn.baseUrl}/browse/${p.key}`,
    }));
  }

  // ─── Boards ────────────────────────────────────────────────────────────────

  async listBoards(conn: JiraConnection, projectKey?: string): Promise<JiraBoard[]> {
    const query = projectKey ? `?projectKeyOrId=${projectKey}&maxResults=50` : '?maxResults=50';
    const data = await this.agileRequest<{ values: any[] }>(conn, `/board${query}`);
    return (data.values || []).map(b => ({
      id: b.id,
      name: b.name,
      type: b.type,
      projectKey: b.location?.projectKey,
    }));
  }

  // ─── Sprints ───────────────────────────────────────────────────────────────

  async listSprints(conn: JiraConnection, boardId: number, state?: string): Promise<JiraSprint[]> {
    const q = state ? `?state=${state}` : '?state=active,future';
    const data = await this.agileRequest<{ values: any[] }>(conn, `/board/${boardId}/sprint${q}`);
    return (data.values || []).map(s => ({
      id: s.id,
      name: s.name,
      state: s.state,
      startDate: s.startDate,
      endDate: s.endDate,
      goal: s.goal,
    }));
  }

  async getSprintIssues(conn: JiraConnection, sprintId: number): Promise<JiraIssue[]> {
    const data = await this.agileRequest<{ issues: any[] }>(
      conn, `/sprint/${sprintId}/issue?maxResults=100`
    );
    return Promise.all((data.issues || []).map(i => this.mapIssue(conn, i)));
  }

  // ─── Issues ────────────────────────────────────────────────────────────────

  async getIssue(conn: JiraConnection, issueKey: string): Promise<JiraIssue> {
    const data = await this.request<any>(
      conn,
      `/issue/${issueKey}?expand=renderedFields,names,changelog`
    );
    return this.mapIssue(conn, data);
  }

  async searchIssues(
    conn: JiraConnection,
    jql: string,
    maxResults = 50,
  ): Promise<JiraSearchResult> {
    const data = await this.request<{ total: number; issues: any[] }>(
      conn,
      `/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&expand=renderedFields`
    );
    const issues = await Promise.all((data.issues || []).map(i => this.mapIssue(conn, i)));
    return { total: data.total, issues };
  }

  /** Convenience: get all open issues in a project */
  async getProjectIssues(conn: JiraConnection, projectKey: string): Promise<JiraSearchResult> {
    return this.searchIssues(conn, `project=${projectKey} AND statusCategory != Done ORDER BY updated DESC`);
  }

  /** Convenience: get my assigned issues */
  async getMyIssues(conn: JiraConnection): Promise<JiraSearchResult> {
    return this.searchIssues(conn, 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  }

  async addComment(conn: JiraConnection, issueKey: string, body: string): Promise<void> {
    await this.request(conn, `/issue/${issueKey}/comment`, 'POST', {
      body: conn.flavour === 'cloud'
        ? { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] }
        : body,
    });
  }

  async updateIssueStatus(conn: JiraConnection, issueKey: string, transitionName: string): Promise<void> {
    // Get available transitions
    const { transitions } = await this.request<{ transitions: any[] }>(
      conn, `/issue/${issueKey}/transitions`
    );
    const t = transitions.find((t: any) =>
      t.name.toLowerCase().includes(transitionName.toLowerCase())
    );
    if (!t) throw new Error(`Transition "${transitionName}" not found. Available: ${transitions.map((t: any) => t.name).join(', ')}`);

    await this.request(conn, `/issue/${issueKey}/transitions`, 'POST', {
      transition: { id: t.id },
    });
  }

  async createIssue(
    conn: JiraConnection,
    projectKey: string,
    summary: string,
    description: string,
    issueType = 'Task',
  ): Promise<{ key: string; url: string }> {
    const data = await this.request<{ key: string }>(conn, '/issue', 'POST', {
      fields: {
        project: { key: projectKey },
        summary,
        description: conn.flavour === 'cloud'
          ? { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] }
          : description,
        issuetype: { name: issueType },
      },
    });
    return { key: data.key, url: `${conn.baseUrl}/browse/${data.key}` };
  }

  async testConnection(conn: JiraConnection): Promise<{ ok: boolean; user?: string; error?: string }> {
    try {
      const data = await this.request<{ displayName?: string; name?: string }>(conn, '/myself');
      return { ok: true, user: data.displayName || data.name };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Mapping ───────────────────────────────────────────────────────────────

  private async mapIssue(conn: JiraConnection, raw: any): Promise<JiraIssue> {
    const f = raw.fields || {};
    const comments: JiraComment[] = (f.comment?.comments || []).slice(0, 10).map((c: any) => ({
      id: c.id,
      author: c.author?.displayName || c.author?.name || 'Unknown',
      body: this.extractText(c.body),
      created: c.created,
    }));

    const attachments: JiraAttachment[] = (f.attachment || []).map((a: any) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      url: a.content,
    }));

    const linkedIssues: LinkedIssue[] = (f.issuelinks || []).map((l: any) => {
      const linked = l.outwardIssue || l.inwardIssue;
      return {
        key: linked?.key || '',
        summary: linked?.fields?.summary || '',
        type: linked?.fields?.issuetype?.name || '',
        linkType: l.type?.name || '',
      };
    });

    return {
      key: raw.key,
      id: raw.id,
      summary: f.summary || '',
      description: this.extractText(f.description),
      type: f.issuetype?.name || 'Task',
      status: f.status?.name || 'Unknown',
      priority: f.priority?.name || 'Medium',
      assignee: f.assignee?.displayName || f.assignee?.name,
      reporter: f.reporter?.displayName || f.reporter?.name,
      labels: f.labels || [],
      components: (f.components || []).map((c: any) => c.name),
      sprint: f.sprint?.name || (Array.isArray(f.customfield_10020) ? f.customfield_10020[0]?.name : undefined),
      storyPoints: f.story_points || f.customfield_10016 || f.customfield_10028,
      created: f.created,
      updated: f.updated,
      url: `${conn.baseUrl}/browse/${raw.key}`,
      comments,
      attachments,
      linkedIssues,
    };
  }

  /** Safely extract text from Jira Atlassian Document Format or plain string */
  private extractText(content: any): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (content.type === 'doc' && Array.isArray(content.content)) {
      return content.content
        .map((block: any) => this.extractText(block))
        .join('\n');
    }
    if (content.type === 'paragraph' && Array.isArray(content.content)) {
      return content.content.map((n: any) => n.text || '').join('');
    }
    if (content.type === 'text') return content.text || '';
    if (Array.isArray(content.content)) {
      return content.content.map((n: any) => this.extractText(n)).join(' ');
    }
    return '';
  }
}

/** Singleton registry of all configured Jira connections */
export class JiraRegistry {
  private connections: Map<string, JiraConnection> = new Map();
  readonly connector = new JiraConnector();

  addConnection(conn: JiraConnection): void {
    this.connections.set(conn.id, conn);
  }

  removeConnection(id: string): void {
    this.connections.delete(id);
  }

  getConnections(): JiraConnection[] {
    return [...this.connections.values()];
  }

  getConnection(id: string): JiraConnection | undefined {
    return this.connections.get(id);
  }
}
