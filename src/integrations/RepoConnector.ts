/**
 * RepoConnector — unified interface for GitHub, GitLab, and Bitbucket.
 *
 * All three providers are normalised to the same data types so the agent
 * and the UI never need to know which platform is in use.
 */

export type RepoProvider = 'github' | 'gitlab' | 'bitbucket';

export interface RepoConnection {
  id: string;
  provider: RepoProvider;
  label: string;           // e.g. "myorg/myrepo"
  baseUrl: string;         // API base
  token: string;           // PAT / OAuth token
  defaultBranch?: string;
}

export interface RepoFile {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  sha?: string;
  downloadUrl?: string;
}

export interface RepoCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface RepoBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export interface RepoPullRequest {
  id: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  branch: string;
  targetBranch: string;
  url: string;
  createdAt: string;
  description: string;
}

/** Every provider adapter implements this interface. */
export interface IRepoAdapter {
  listFiles(conn: RepoConnection, path: string, ref?: string): Promise<RepoFile[]>;
  readFile(conn: RepoConnection, path: string, ref?: string): Promise<string>;
  listBranches(conn: RepoConnection): Promise<RepoBranch[]>;
  listCommits(conn: RepoConnection, branch?: string, limit?: number): Promise<RepoCommit[]>;
  listPullRequests(conn: RepoConnection, state?: 'open' | 'closed' | 'all'): Promise<RepoPullRequest[]>;
  searchCode(conn: RepoConnection, query: string): Promise<RepoFile[]>;
}

/** ── GitHub Adapter ───────────────────────────────────────────────────────── */
export class GitHubAdapter implements IRepoAdapter {
  private async fetch<T>(conn: RepoConnection, path: string): Promise<T> {
    const base = conn.baseUrl || 'https://api.github.com';
    const res = await fetch(`${base}${path}`, {
      headers: {
        Authorization: `Bearer ${conn.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async listFiles(conn: RepoConnection, path: string, ref?: string): Promise<RepoFile[]> {
    const [owner, repo] = conn.label.split('/');
    const branch = ref || conn.defaultBranch || 'main';
    const data = await this.fetch<any[]>(conn, `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
    return data.map(f => ({
      path: f.path,
      type: f.type === 'dir' ? 'dir' : 'file',
      size: f.size,
      sha: f.sha,
      downloadUrl: f.download_url,
    }));
  }

  async readFile(conn: RepoConnection, path: string, ref?: string): Promise<string> {
    const [owner, repo] = conn.label.split('/');
    const branch = ref || conn.defaultBranch || 'main';
    const data = await this.fetch<{ content: string; encoding: string }>(
      conn, `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`
    );
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }

  async listBranches(conn: RepoConnection): Promise<RepoBranch[]> {
    const [owner, repo] = conn.label.split('/');
    const data = await this.fetch<any[]>(conn, `/repos/${owner}/${repo}/branches?per_page=100`);
    return data.map(b => ({ name: b.name, sha: b.commit.sha, protected: b.protected }));
  }

  async listCommits(conn: RepoConnection, branch = 'main', limit = 20): Promise<RepoCommit[]> {
    const [owner, repo] = conn.label.split('/');
    const data = await this.fetch<any[]>(conn, `/repos/${owner}/${repo}/commits?sha=${branch}&per_page=${limit}`);
    return data.map(c => ({
      sha: c.sha.slice(0, 8),
      message: c.commit.message.split('\n')[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
      url: c.html_url,
    }));
  }

  async listPullRequests(conn: RepoConnection, state: 'open' | 'closed' | 'all' = 'open'): Promise<RepoPullRequest[]> {
    const [owner, repo] = conn.label.split('/');
    const data = await this.fetch<any[]>(conn, `/repos/${owner}/${repo}/pulls?state=${state}&per_page=50`);
    return data.map(pr => ({
      id: pr.number,
      title: pr.title,
      state: pr.merged_at ? 'merged' : pr.state as any,
      author: pr.user.login,
      branch: pr.head.ref,
      targetBranch: pr.base.ref,
      url: pr.html_url,
      createdAt: pr.created_at,
      description: pr.body || '',
    }));
  }

  async searchCode(conn: RepoConnection, query: string): Promise<RepoFile[]> {
    const [owner, repo] = conn.label.split('/');
    const data = await this.fetch<{ items: any[] }>(
      conn, `/search/code?q=${encodeURIComponent(query)}+repo:${owner}/${repo}&per_page=20`
    );
    return (data.items || []).map(f => ({ path: f.path, type: 'file' as const, sha: f.sha }));
  }
}

/** ── GitLab Adapter ───────────────────────────────────────────────────────── */
export class GitLabAdapter implements IRepoAdapter {
  private async fetch<T>(conn: RepoConnection, path: string): Promise<T> {
    const base = conn.baseUrl || 'https://gitlab.com/api/v4';
    const projectId = encodeURIComponent(conn.label);
    const fullPath = path.replace(':projectId', projectId);
    const res = await fetch(`${base}${fullPath}`, {
      headers: { 'PRIVATE-TOKEN': conn.token },
    });
    if (!res.ok) throw new Error(`GitLab API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async listFiles(conn: RepoConnection, path: string, ref?: string): Promise<RepoFile[]> {
    const branch = ref || conn.defaultBranch || 'main';
    const data = await this.fetch<any[]>(
      conn, `/projects/:projectId/repository/tree?path=${path}&ref=${branch}&per_page=100`
    );
    return data.map(f => ({
      path: f.path,
      type: f.type === 'tree' ? 'dir' : 'file',
      sha: f.id,
    }));
  }

  async readFile(conn: RepoConnection, path: string, ref?: string): Promise<string> {
    const branch = ref || conn.defaultBranch || 'main';
    const encoded = encodeURIComponent(path);
    const data = await this.fetch<{ content: string }>(
      conn, `/projects/:projectId/repository/files/${encoded}?ref=${branch}`
    );
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }

  async listBranches(conn: RepoConnection): Promise<RepoBranch[]> {
    const data = await this.fetch<any[]>(conn, `/projects/:projectId/repository/branches?per_page=100`);
    return data.map(b => ({ name: b.name, sha: b.commit.id, protected: b.protected }));
  }

  async listCommits(conn: RepoConnection, branch = 'main', limit = 20): Promise<RepoCommit[]> {
    const data = await this.fetch<any[]>(
      conn, `/projects/:projectId/repository/commits?ref_name=${branch}&per_page=${limit}`
    );
    return data.map(c => ({
      sha: c.id.slice(0, 8),
      message: c.title,
      author: c.author_name,
      date: c.created_at,
      url: c.web_url,
    }));
  }

  async listPullRequests(conn: RepoConnection, state: 'open' | 'closed' | 'all' = 'open'): Promise<RepoPullRequest[]> {
    const glState = state === 'open' ? 'opened' : state === 'closed' ? 'closed' : 'all';
    const data = await this.fetch<any[]>(
      conn, `/projects/:projectId/merge_requests?state=${glState}&per_page=50`
    );
    return data.map(mr => ({
      id: mr.iid,
      title: mr.title,
      state: mr.state === 'opened' ? 'open' : mr.state === 'merged' ? 'merged' : 'closed',
      author: mr.author.username,
      branch: mr.source_branch,
      targetBranch: mr.target_branch,
      url: mr.web_url,
      createdAt: mr.created_at,
      description: mr.description || '',
    }));
  }

  async searchCode(conn: RepoConnection, query: string): Promise<RepoFile[]> {
    const data = await this.fetch<any[]>(
      conn, `/projects/:projectId/search?scope=blobs&search=${encodeURIComponent(query)}&per_page=20`
    );
    return data.map(f => ({ path: f.path, type: 'file' as const }));
  }
}

/** ── Bitbucket Adapter ────────────────────────────────────────────────────── */
export class BitbucketAdapter implements IRepoAdapter {
  private async fetch<T>(conn: RepoConnection, path: string): Promise<T> {
    const base = conn.baseUrl || 'https://api.bitbucket.org/2.0';
    const [workspace, slug] = conn.label.split('/');
    const fullPath = path.replace(':workspace', workspace).replace(':slug', slug);
    const res = await fetch(`${base}${fullPath}`, {
      headers: {
        Authorization: `Bearer ${conn.token}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`Bitbucket API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async listFiles(conn: RepoConnection, path: string, ref?: string): Promise<RepoFile[]> {
    const branch = ref || conn.defaultBranch || 'main';
    const data = await this.fetch<{ values: any[] }>(
      conn, `/repositories/:workspace/:slug/src/${branch}/${path}`
    );
    return (data.values || []).map((f: any) => ({
      path: f.path,
      type: f.type === 'commit_directory' ? 'dir' : 'file',
      size: f.size,
    }));
  }

  async readFile(conn: RepoConnection, path: string, ref?: string): Promise<string> {
    const branch = ref || conn.defaultBranch || 'main';
    const base = conn.baseUrl || 'https://api.bitbucket.org/2.0';
    const [workspace, slug] = conn.label.split('/');
    const res = await fetch(`${base}/repositories/${workspace}/${slug}/src/${branch}/${path}`, {
      headers: { Authorization: `Bearer ${conn.token}` },
    });
    if (!res.ok) throw new Error(`Bitbucket ${res.status}`);
    return res.text();
  }

  async listBranches(conn: RepoConnection): Promise<RepoBranch[]> {
    const data = await this.fetch<{ values: any[] }>(
      conn, `/repositories/:workspace/:slug/refs/branches?pagelen=100`
    );
    return (data.values || []).map((b: any) => ({
      name: b.name,
      sha: b.target.hash.slice(0, 8),
      protected: false,
    }));
  }

  async listCommits(conn: RepoConnection, branch = 'main', limit = 20): Promise<RepoCommit[]> {
    const data = await this.fetch<{ values: any[] }>(
      conn, `/repositories/:workspace/:slug/commits/${branch}?pagelen=${limit}`
    );
    return (data.values || []).map((c: any) => ({
      sha: c.hash.slice(0, 8),
      message: c.message.split('\n')[0],
      author: c.author.raw,
      date: c.date,
      url: c.links.html.href,
    }));
  }

  async listPullRequests(conn: RepoConnection, state: 'open' | 'closed' | 'all' = 'open'): Promise<RepoPullRequest[]> {
    const bbState = state === 'open' ? 'OPEN' : state === 'closed' ? 'MERGED,DECLINED' : 'ALL';
    const data = await this.fetch<{ values: any[] }>(
      conn, `/repositories/:workspace/:slug/pullrequests?state=${bbState}&pagelen=50`
    );
    return (data.values || []).map((pr: any) => ({
      id: pr.id,
      title: pr.title,
      state: pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed',
      author: pr.author.display_name,
      branch: pr.source.branch.name,
      targetBranch: pr.destination.branch.name,
      url: pr.links.html.href,
      createdAt: pr.created_on,
      description: pr.description || '',
    }));
  }

  async searchCode(conn: RepoConnection, query: string): Promise<RepoFile[]> {
    // Bitbucket code search requires Bitbucket Cloud API; simplified here
    const data = await this.fetch<{ values: any[] }>(
      conn, `/repositories/:workspace/:slug/search/code?search_query=${encodeURIComponent(query)}&pagelen=20`
    );
    return (data.values || []).map((f: any) => ({ path: f.file.path, type: 'file' as const }));
  }
}

/** ── Registry ────────────────────────────────────────────────────────────── */
export class RepoConnectorRegistry {
  private connections: Map<string, RepoConnection> = new Map();
  private adapters: Map<RepoProvider, IRepoAdapter> = new Map<RepoProvider, IRepoAdapter>([
    ['github', new GitHubAdapter()],
    ['gitlab', new GitLabAdapter()],
    ['bitbucket', new BitbucketAdapter()],
  ]);

  addConnection(conn: RepoConnection): void {
    this.connections.set(conn.id, conn);
  }

  removeConnection(id: string): void {
    this.connections.delete(id);
  }

  getConnections(): RepoConnection[] {
    return [...this.connections.values()];
  }

  getConnection(id: string): RepoConnection | undefined {
    return this.connections.get(id);
  }

  getAdapter(provider: RepoProvider): IRepoAdapter {
    return this.adapters.get(provider)!;
  }

  async testConnection(conn: RepoConnection): Promise<boolean> {
    try {
      const adapter = this.getAdapter(conn.provider);
      await adapter.listBranches(conn);
      return true;
    } catch {
      return false;
    }
  }
}
