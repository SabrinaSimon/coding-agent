import { BaseTool, ToolSchema } from '../tools/base/Tool';
import { ReadTool } from '../tools/filesystem/ReadTool';
import { WriteTool } from '../tools/filesystem/WriteTool';
import { EditTool } from '../tools/filesystem/EditTool';
import { GlobTool } from '../tools/filesystem/GlobTool';
import { GrepTool } from '../tools/filesystem/GrepTool';
import { BashTool } from '../tools/shell/BashTool';
import { GitTool } from '../tools/git/GitTool';
import { WebFetchTool } from '../tools/web/WebFetchTool';

/**
 * Registry that holds all available tools and maps name → instance.
 * Add new tools here to make them available to the agent.
 */
export class ToolRegistry {
  private tools: Map<string, BaseTool> = new Map();

  constructor() {
    this.register(new ReadTool());
    this.register(new WriteTool());
    this.register(new EditTool());
    this.register(new GlobTool());
    this.register(new GrepTool());
    this.register(new BashTool());
    this.register(new GitTool());
    this.register(new WebFetchTool());
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
