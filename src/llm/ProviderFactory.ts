import * as vscode from 'vscode';
import { ILLMProvider } from './providers/BaseProvider';
import { AnthropicProvider } from './providers/AnthropicProvider';
import { OpenAIProvider } from './providers/OpenAIProvider';

const API_KEY_SECRETS: Record<string, string> = {
  anthropic: 'codingAgent.anthropicApiKey',
  openai: 'codingAgent.openaiApiKey',
};

export class ProviderFactory {
  static async create(
    context: vscode.ExtensionContext,
  ): Promise<ILLMProvider> {
    const config = vscode.workspace.getConfiguration('codingAgent');
    const providerName = config.get<string>('provider', 'anthropic');

    const apiKey = await context.secrets.get(API_KEY_SECRETS[providerName]);
    if (!apiKey) {
      throw new Error(
        `No API key configured for "${providerName}". ` +
        `Run "Coding Agent: Configure API Key" from the command palette.`,
      );
    }

    switch (providerName) {
      case 'anthropic':
        return new AnthropicProvider(apiKey);
      case 'openai':
        return new OpenAIProvider(apiKey);
      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
  }

  static async storeApiKey(
    context: vscode.ExtensionContext,
    provider: string,
    apiKey: string,
  ): Promise<void> {
    const secretKey = API_KEY_SECRETS[provider];
    if (!secretKey) throw new Error(`Unknown provider: ${provider}`);
    await context.secrets.store(secretKey, apiKey);
  }
}
