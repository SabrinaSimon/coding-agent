import * as vscode from 'vscode';
import { ILLMProvider } from './providers/BaseProvider';
import { AnthropicProvider } from './providers/AnthropicProvider';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { VSCodeLMProvider } from './providers/VSCodeLMProvider';

const API_KEY_SECRETS: Record<string, string> = {
  anthropic: 'codingAgent.anthropicApiKey',
  openai: 'codingAgent.openaiApiKey',
};

export class ProviderFactory {
  /**
   * Create the correct provider based on the current configuration.
   *
   * Priority:
   *   1. If provider = "copilot" → use VSCode LM API (GitHub Copilot, no key needed)
   *   2. If provider = "anthropic" / "openai" → look up API key from Secret Storage
   *   3. If NO key is configured at all → fall back to Copilot automatically,
   *      prompting the user first so they know what's happening
   */
  static async create(context: vscode.ExtensionContext): Promise<ILLMProvider> {
    const config = vscode.workspace.getConfiguration('codingAgent');
    const providerName = config.get<string>('provider', 'copilot');

    // ── Copilot / VSCode LM path (zero API key) ──────────────────────────────
    if (providerName === 'copilot') {
      const provider = new VSCodeLMProvider();
      const available = await provider.validateConnection();
      if (!available) {
        throw new Error(
          'GitHub Copilot is not available. ' +
          'Please install "GitHub Copilot Chat" extension and sign in, ' +
          'or configure an Anthropic/OpenAI API key instead.',
        );
      }
      return provider;
    }

    // ── API-key based providers ───────────────────────────────────────────────
    const secretKey = API_KEY_SECRETS[providerName];
    if (!secretKey) throw new Error(`Unknown provider: ${providerName}`);

    const apiKey = await context.secrets.get(secretKey);

    // Auto-fallback: if no key → offer Copilot as alternative
    if (!apiKey) {
      const copilot = new VSCodeLMProvider();
      const copilotAvailable = await copilot.validateConnection();

      if (copilotAvailable) {
        const choice = await vscode.window.showWarningMessage(
          `No ${providerName} API key configured. Use GitHub Copilot instead?`,
          'Use Copilot (recommended)',
          'Configure API Key',
        );
        if (choice === 'Use Copilot (recommended)') {
          await vscode.workspace.getConfiguration('codingAgent').update(
            'provider', 'copilot', vscode.ConfigurationTarget.Global,
          );
          return copilot;
        }
      }

      throw new Error(
        `No API key configured for "${providerName}". ` +
        `Run "Coding Agent: Configure API Key" from the command palette.`,
      );
    }

    switch (providerName) {
      case 'anthropic': return new AnthropicProvider(apiKey);
      case 'openai':    return new OpenAIProvider(apiKey);
      default:          throw new Error(`Unknown provider: ${providerName}`);
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
