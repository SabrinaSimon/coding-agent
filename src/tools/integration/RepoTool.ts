import { BaseTool, RiskLevel, ToolInput, ToolResult, ToolSchema, ToolContext } from '../base/Tool';
import { RepoConnectorRegistry } from '../../integrations/RepoConnector';

interface RepoToolInput extends ToolInput {
  operation: 'list_files' | 'read_file' | 'list_branches' | 'list_commits' | 'list_prs' | 'search_code';
  connection_id: string;
  path?: string;
  ref?: string;
  query?: string;
  state?: 'open' | 'closed' | 'all';
  limit?: number;
}

export class RepoTool extends BaseTool {
  readonly name = 'repo';
  readonly description =
    'Access connected code repositories (GitHub, GitLab, Bitbucket). Read files, list branches, view commits, list pull requests, and search code across any connected remote repository.';
  readonly riskLevel = RiskLevel.SAFE;

  readonly schema: ToolSchema = {
    name: this.name,
    description: this.description,
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list_files', 'read_file', 'list_branches', 'list_commits', 'list_prs', 'search_code'],
          description: 'The operation to perform on the repository',
        },
        connection_id: {
          type: 'string',
          description: 'ID of the repository connection to use',
        },
        path: {
          type: 'string',
          description: 'File or directory path within the repository (for list_files, read_file)',
        },
        ref: {
          type: 'string',
          description: 'Branch name, tag, or commit SHA (default: default branch)',
        },
        query: {
          type: 'string',
          description: 'Search query for search_code operation',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'PR state filter for list_prs (default: open)',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return for list_commits (default: 20)',
        },
      },
      required: ['operation', 'connection_id'],
    },
  };

  constructor(private registry: RepoConnectorRegistry) {
    super();
  }

  summarize(input: ToolInput): string {
    const r = input as RepoToolInput;
    return `Repo [${r.connection_id}]: ${r.operation}${r.path ? ' ' + r.path : ''}`;
  }

  async execute(input: ToolInput, _context: ToolContext): Promise<ToolResult> {
    const { operation, connection_id, path = '', ref, query, state, limit } = input as RepoToolInput;

    const conn = this.registry.getConnection(connection_id);
    if (!conn) {
      const ids = this.registry.getConnections().map(c => `${c.id} (${c.label})`).join(', ');
      return {
        success: false,
        output: '',
        error: `No repository connection with id "${connection_id}". Available: ${ids || 'none configured'}`,
      };
    }

    const adapter = this.registry.getAdapter(conn.provider);

    try {
      switch (operation) {
        case 'list_files': {
          const files = await adapter.listFiles(conn, path, ref);
          const formatted = files.map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.path}${f.size ? ` (${f.size}B)` : ''}`).join('\n');
          return { success: true, output: formatted || '(empty directory)', metadata: { count: files.length } };
        }

        case 'read_file': {
          if (!path) return { success: false, output: '', error: 'path is required for read_file' };
          const content = await adapter.readFile(conn, path, ref);
          return { success: true, output: content, metadata: { path, ref } };
        }

        case 'list_branches': {
          const branches = await adapter.listBranches(conn);
          const formatted = branches.map(b =>
            `${b.protected ? '🔒' : '🌿'} ${b.name} (${b.sha})${b.name === conn.defaultBranch ? ' [default]' : ''}`
          ).join('\n');
          return { success: true, output: formatted, metadata: { count: branches.length } };
        }

        case 'list_commits': {
          const commits = await adapter.listCommits(conn, ref, limit || 20);
          const formatted = commits.map(c =>
            `${c.sha} | ${c.date.slice(0, 10)} | ${c.author.padEnd(20)} | ${c.message}`
          ).join('\n');
          return { success: true, output: formatted, metadata: { count: commits.length } };
        }

        case 'list_prs': {
          const prs = await adapter.listPullRequests(conn, state || 'open');
          const formatted = prs.map(pr =>
            `#${pr.id} [${pr.state.toUpperCase()}] ${pr.title}\n  Author: ${pr.author} | ${pr.branch} → ${pr.targetBranch}\n  ${pr.url}`
          ).join('\n\n');
          return { success: true, output: formatted || '(no pull requests)', metadata: { count: prs.length } };
        }

        case 'search_code': {
          if (!query) return { success: false, output: '', error: 'query is required for search_code' };
          const files = await adapter.searchCode(conn, query);
          const formatted = files.map(f => f.path).join('\n');
          return { success: true, output: formatted || '(no results)', metadata: { count: files.length } };
        }

        default:
          return { success: false, output: '', error: `Unknown operation: ${operation}` };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Repository operation failed: ${message}` };
    }
  }
}
