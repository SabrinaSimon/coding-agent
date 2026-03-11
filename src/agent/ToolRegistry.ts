import { BaseTool, ToolSchema } from '../tools/base/Tool';
import { ReadTool } from '../tools/filesystem/ReadTool';
import { WriteTool } from '../tools/filesystem/WriteTool';
import { EditTool } from '../tools/filesystem/EditTool';
import { GlobTool } from '../tools/filesystem/GlobTool';
import { GrepTool } from '../tools/filesystem/GrepTool';
import { BashTool } from '../tools/shell/BashTool';
import { GitTool } from '../tools/git/GitTool';
import { WebFetchTool } from '../tools/web/WebFetchTool';
import { RepoTool } from '../tools/integration/RepoTool';
import { JiraTool } from '../tools/integration/JiraTool';
import { RepoConnectorRegistry } from '../integrations/RepoConnector';
import { JiraRegistry } from '../integrations/jira/JiraConnector';

/**
 * Registry that holds all available tools and maps name → instance.
 * Add new tools here to make them available to the agent.
 */
export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();

  constructor(
    repoRegistry?: RepoConnectorRegistry,
    jiraRegistry?: JiraRegistry,
  ) {
    // Core developer tools
    this.register(new ReadTool());
    this.register(new WriteTool());
    this.register(new EditTool());
    this.register(new GlobTool());
    this.register(new GrepTool());
    this.register(new BashTool());
    this.register(new GitTool());
    this.register(new WebFetchTool());

    // Integration tools (optional — only registered if registries provided)
    if (repoRegistry) {
      this.register(new RepoTool(repoRegistry));
    }
    if (jiraRegistry) {
      this.register(new JiraTool(jiraRegistry));
    }
  }

  register(tool: BaseTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  getAll(): BaseTool[] {
    return [...this.tools.values()];
  }

  getSchemas(): ToolSchema[] {
    return this.getAll().map(t => t.toAnthropicSchema());
  }

  getOpenAISchemas(): object[] {
    return this.getAll().map(t => t.toOpenAISchema());
  }
}
