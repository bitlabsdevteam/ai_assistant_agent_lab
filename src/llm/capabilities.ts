import { AppError } from "../errors.js";
import type { LLMProvider } from "../schemas.js";
import type { ResolvedLLMConfig } from "./routing.js";

const PROVIDER_API_KEYS: Record<LLMProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
};

const STRUCTURED_OUTPUT_MODEL_PATTERNS: Record<LLMProvider, RegExp[]> = {
  openai: [/^gpt-5(?:[.-]|$)/i, /^o[34](?:[.-]|$)/i],
  anthropic: [/^claude(?:[.-]|$)/i],
  gemini: [/^(?:models\/)?gemini(?:[.-]|$)/i],
  moonshot: [/^kimi(?:[.-]|$)/i, /^moonshot(?:[.-]|$)/i],
};

const CONTEXT_WINDOW_MATCHERS: Array<{
  provider: LLMProvider;
  pattern: RegExp;
  tokens: number;
}> = [
  { provider: "openai", pattern: /^gpt-5(?:[.-]|$)/i, tokens: 128_000 },
  { provider: "openai", pattern: /^o[34](?:[.-]|$)/i, tokens: 200_000 },
  { provider: "anthropic", pattern: /^claude(?:[.-]|$)/i, tokens: 200_000 },
  { provider: "gemini", pattern: /^(?:models\/)?gemini(?:[.-]|$)/i, tokens: 1_048_576 },
  { provider: "moonshot", pattern: /^kimi(?:[.-]|$)/i, tokens: 128_000 },
  { provider: "moonshot", pattern: /^moonshot(?:[.-]|$)/i, tokens: 128_000 },
];

export function getProviderApiKeyEnvVar(provider: LLMProvider): string {
  return PROVIDER_API_KEYS[provider];
}

export function isStructuredOutputModelSupported(provider: LLMProvider, model: string): boolean {
  return STRUCTURED_OUTPUT_MODEL_PATTERNS[provider].some((pattern) => pattern.test(model));
}

export function assertStructuredOutputSupport(config: Pick<ResolvedLLMConfig, "provider" | "model">): void {
  if (isStructuredOutputModelSupported(config.provider, config.model)) {
    return;
  }
  throw new AppError(
    "CONFIG_ERROR",
    `Provider '${config.provider}' model '${config.model}' is not in Argus's validated strict structured-output support matrix.`,
    {
      details: {
        provider: config.provider,
        model: config.model,
      },
    },
  );
}

export function resolveBuiltInContextWindow(provider: LLMProvider, model: string): number | undefined {
  return CONTEXT_WINDOW_MATCHERS.find((entry) => entry.provider === provider && entry.pattern.test(model))?.tokens;
}
