import { BaseTool, RiskLevel, ToolInput, ToolResult, ToolSchema, ToolContext } from '../base/Tool';
import { JiraRegistry } from '../../integrations/jira/JiraConnector';

interface JiraToolInput extends ToolInput {
  operation:
    | 'list_projects'
    | 'list_boards'
    | 'list_sprints'
    | 'get_sprint_issues'
    | 'get_issue'
    | 'search_issues'
    | 'get_my_issues'
    | 'get_project_issues'
    | 'add_comment'
    | 'create_issue'
    | 'update_status';
  connection_id: string;
  project_key?: string;
  board_id?: number;
  sprint_id?: number;
  issue_key?: string;
  jql?: string;
  summary?: string;
  description?: string;
  issue_type?: string;
  comment?: string;
  status?: string;
  max_results?: number;
}

export class JiraTool extends BaseTool {
  readonly name = 'jira';
  readonly description =
    'Access and manage Jira boards, sprints, and issues. List projects, boards, sprints, search issues by JQL, read issue details (description, comments, attachments, linked issues), add comments, create issues, and transition issue statuses.';
  readonly riskLevel = RiskLevel.CAUTION;

  readonly schema: ToolSchema = {
    name: this.name,
    description: this.description,
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'list_projects', 'list_boards', 'list_sprints', 'get_sprint_issues',
            'get_issue', 'search_issues', 'get_my_issues', 'get_project_issues',
            'add_comment', 'create_issue', 'update_status',
          ],
          description: 'The Jira operation to perform',
        },
        connection_id: {
          type: 'string',
          description: 'ID of the Jira connection to use',
        },
        project_key: {
          type: 'string',
          description: 'Jira project key, e.g. "PROJ" (for project/board/issue operations)',
        },
        board_id: {
          type: 'number',
          description: 'Board ID for list_sprints and sprint-related operations',
        },
        sprint_id: {
          type: 'number',
          description: 'Sprint ID for get_sprint_issues',
        },
        issue_key: {
          type: 'string',
          description: 'Issue key e.g. "PROJ-123" for get_issue, add_comment, update_status',
        },
        jql: {
          type: 'string',
          description: 'Jira Query Language string for search_issues, e.g. "project=PROJ AND status=\'In Progress\'"',
        },
        summary: {
          type: 'string',
          description: 'Issue summary/title for create_issue',
        },
        description: {
          type: 'string',
          description: 'Issue description for create_issue',
        },
        issue_type: {
          type: 'string',
          description: 'Issue type for create_issue (Task, Bug, Story, Epic, etc.)',
        },
        comment: {
          type: 'string',
          description: 'Comment text for add_comment',
        },
        status: {
          type: 'string',
          description: 'Target status name for update_status, e.g. "In Progress", "Done"',
        },
        max_results: {
          type: 'number',
          description: 'Maximum issues to return for search operations (default: 20)',
        },
      },
      required: ['operation', 'connection_id'],
    },
  };

  constructor(private registry: JiraRegistry) {
    super();
  }

  summarize(input: ToolInput): string {
    const j = input as JiraToolInput;
    const detail = j.issue_key || j.project_key || j.jql || '';
    return `Jira [${j.connection_id}]: ${j.operation}${detail ? ' ' + detail : ''}`;
  }

  getRiskLevel(input: ToolInput): RiskLevel {
    const j = input as JiraToolInput;
    if (['add_comment', 'create_issue', 'update_status'].includes(j.operation)) {
      return RiskLevel.DANGER;
    }
    return RiskLevel.SAFE;
  }

  async execute(input: ToolInput, _context: ToolContext): Promise<ToolResult> {
    const j = input as JiraToolInput;

    const conn = this.registry.getConnection(j.connection_id);
    if (!conn) {
      const ids = this.registry.getConnections().map(c => `${c.id} (${c.label})`).join(', ');
      return {
        success: false,
        output: '',
        error: `No Jira connection with id "${j.connection_id}". Available: ${ids || 'none configured'}`,
      };
    }

    const jira = this.registry.connector;

    try {
      switch (j.operation) {
        case 'list_projects': {
          const projects = await jira.listProjects(conn);
          const out = projects.map(p =>
            `[${p.key}] ${p.name} (${p.type})${p.leadName ? ' — Lead: ' + p.leadName : ''}`
          ).join('\n');
          return { success: true, output: out || '(no projects)', metadata: { count: projects.length } };
        }

        case 'list_boards': {
          const boards = await jira.listBoards(conn, j.project_key);
          const out = boards.map(b =>
            `Board #${b.id}: ${b.name} [${b.type}]${b.projectKey ? ' — Project: ' + b.projectKey : ''}`
          ).join('\n');
          return { success: true, output: out || '(no boards)', metadata: { count: boards.length } };
        }

        case 'list_sprints': {
          if (!j.board_id) return { success: false, output: '', error: 'board_id required for list_sprints' };
          const sprints = await jira.listSprints(conn, j.board_id);
          const out = sprints.map(s =>
            `Sprint #${s.id}: ${s.name} [${s.state.toUpperCase()}]` +
            (s.startDate ? `\n  Dates: ${s.startDate?.slice(0,10)} → ${s.endDate?.slice(0,10)}` : '') +
            (s.goal ? `\n  Goal: ${s.goal}` : '')
          ).join('\n\n');
          return { success: true, output: out || '(no sprints)', metadata: { count: sprints.length } };
        }

        case 'get_sprint_issues': {
          if (!j.sprint_id) return { success: false, output: '', error: 'sprint_id required' };
          const issues = await jira.getSprintIssues(conn, j.sprint_id);
          return { success: true, output: this.formatIssueList(issues), metadata: { count: issues.length } };
        }

        case 'get_issue': {
          if (!j.issue_key) return { success: false, output: '', error: 'issue_key required' };
          const issue = await jira.getIssue(conn, j.issue_key);
          return { success: true, output: this.formatIssueDetail(issue) };
        }

        case 'search_issues': {
          if (!j.jql) return { success: false, output: '', error: 'jql required for search_issues' };
          const result = await jira.searchIssues(conn, j.jql, j.max_results || 20);
          const out = `Total: ${result.total} issues (showing ${result.issues.length})\n\n` +
            this.formatIssueList(result.issues);
          return { success: true, output: out, metadata: { total: result.total } };
        }

        case 'get_my_issues': {
          const result = await jira.getMyIssues(conn);
          return { success: true, output: this.formatIssueList(result.issues), metadata: { total: result.total } };
        }

        case 'get_project_issues': {
          if (!j.project_key) return { success: false, output: '', error: 'project_key required' };
          const result = await jira.getProjectIssues(conn, j.project_key);
          const out = `Total: ${result.total} (showing ${result.issues.length})\n\n` +
            this.formatIssueList(result.issues);
          return { success: true, output: out };
        }

        case 'add_comment': {
          if (!j.issue_key) return { success: false, output: '', error: 'issue_key required' };
          if (!j.comment) return { success: false, output: '', error: 'comment required' };
          await jira.addComment(conn, j.issue_key, j.comment);
          return { success: true, output: `Comment added to ${j.issue_key}` };
        }

        case 'create_issue': {
          if (!j.project_key) return { success: false, output: '', error: 'project_key required' };
          if (!j.summary) return { success: false, output: '', error: 'summary required' };
          const created = await jira.createIssue(
            conn, j.project_key, j.summary, j.description || '', j.issue_type || 'Task'
          );
          return { success: true, output: `Created: ${created.key}\n${created.url}` };
        }

        case 'update_status': {
          if (!j.issue_key) return { success: false, output: '', error: 'issue_key required' };
          if (!j.status) return { success: false, output: '', error: 'status required' };
          await jira.updateIssueStatus(conn, j.issue_key, j.status);
          return { success: true, output: `${j.issue_key} transitioned to "${j.status}"` };
        }

        default:
          return { success: false, output: '', error: `Unknown Jira operation: ${j.operation}` };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Jira operation failed: ${message}` };
    }
  }

  private formatIssueList(issues: import('../../integrations/jira/JiraConnector').JiraIssue[]): string {
    if (!issues.length) return '(no issues)';
    return issues.map(i =>
      `[${i.key}] ${i.type} | ${i.status} | ${i.priority}\n` +
      `  ${i.summary}\n` +
      `  Assignee: ${i.assignee || 'Unassigned'} | Points: ${i.storyPoints ?? '?'}` +
      (i.sprint ? ` | Sprint: ${i.sprint}` : '') + '\n' +
      `  ${i.url}`
    ).join('\n\n');
  }

  private formatIssueDetail(i: import('../../integrations/jira/JiraConnector').JiraIssue): string {
    const lines = [
      `## ${i.key}: ${i.summary}`,
      `**Type:** ${i.type}  |  **Status:** ${i.status}  |  **Priority:** ${i.priority}`,
      `**Assignee:** ${i.assignee || 'Unassigned'}  |  **Reporter:** ${i.reporter || 'Unknown'}`,
    ];
    if (i.sprint) lines.push(`**Sprint:** ${i.sprint}`);
    if (i.storyPoints) lines.push(`**Story Points:** ${i.storyPoints}`);
    if (i.labels.length) lines.push(`**Labels:** ${i.labels.join(', ')}`);
    if (i.components.length) lines.push(`**Components:** ${i.components.join(', ')}`);
    lines.push(`**URL:** ${i.url}`);

    if (i.description) {
      lines.push('', '### Description', i.description);
    }

    if (i.linkedIssues.length) {
      lines.push('', '### Linked Issues');
      i.linkedIssues.forEach(l => lines.push(`- [${l.key}] ${l.linkType}: ${l.summary}`));
    }

    if (i.comments.length) {
      lines.push('', `### Comments (${i.comments.length})`);
      i.comments.forEach(c => {
        lines.push(`\n**${c.author}** (${c.created.slice(0, 10)}):`, c.body);
      });
    }

    if (i.attachments.length) {
      lines.push('', '### Attachments');
      i.attachments.forEach(a => lines.push(`- ${a.filename} (${(a.size / 1024).toFixed(1)}KB)`));
    }

    return lines.join('\n');
  }
}
