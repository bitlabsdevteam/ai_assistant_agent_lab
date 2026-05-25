import { z } from "zod";

import { resolveWorkspaceEnvValue } from "../env.js";
import { AppError } from "../errors.js";
import { buildDescriptor, type Tool, type ToolContext } from "./base.js";

const FetchInputSchema = z.object({
  url: z.string().url(),
});
const FetchOutputSchema = z.object({
  url: z.string().url(),
  status: z.number().int(),
  body: z.string(),
});

export class WebFetchTool implements Tool<typeof FetchInputSchema, typeof FetchOutputSchema> {
  public readonly descriptor = buildDescriptor({
    name: "web.fetch",
    description: "Fetch an allowlisted URL.",
    category: "network",
    riskLevel: "medium",
    sideEffecting: false,
    requiresApproval: false,
    permissionScope: "network",
  });
  public readonly inputSchema = FetchInputSchema;
  public readonly outputSchema = FetchOutputSchema;

  public validate(input: z.infer<typeof FetchInputSchema>, context: ToolContext): void {
    context.policy.ensureNetworkAllowed(input.url, {
      toolName: this.descriptor.name,
      input,
      approvals: context.approvals,
    });
  }

  public async run(input: z.infer<typeof FetchInputSchema>, context: ToolContext): Promise<z.infer<typeof FetchOutputSchema>> {
    this.validate(input, context);
    const response = await fetch(input.url, { signal: context.signal });
    const body = await response.text();
    return {
      url: input.url,
      status: response.status,
      body: body.slice(0, context.settings.maxToolOutputChars),
    };
  }
}

const PerplexitySearchInputSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(20).default(5),
  searchDomainFilter: z.array(z.string().min(1)).max(20).optional(),
  searchRecencyFilter: z.enum(["day", "week", "month", "year"]).optional(),
});

const PerplexitySearchOutputSchema = z.object({
  provider: z.literal("perplexity"),
  query: z.string(),
  searchId: z.string().optional(),
  resultCount: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string().url(),
      snippet: z.string(),
      date: z.string().optional(),
      lastUpdated: z.string().optional(),
    }),
  ),
});

const PerplexitySearchResponseSchema = z.object({
  search_id: z.string().optional(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string().url(),
      snippet: z.string(),
      date: z.string().optional(),
      last_updated: z.string().optional(),
    }),
  ),
});

const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";

export class WebSearchTool implements Tool<typeof PerplexitySearchInputSchema, typeof PerplexitySearchOutputSchema> {
  public readonly descriptor = buildDescriptor({
    name: "web.search",
    description: "Search the web via the Perplexity Search API.",
    category: "network",
    riskLevel: "medium",
    sideEffecting: false,
    requiresApproval: false,
    permissionScope: "network",
  });
  public readonly inputSchema = PerplexitySearchInputSchema;
  public readonly outputSchema = PerplexitySearchOutputSchema;

  public validate(_input: z.infer<typeof PerplexitySearchInputSchema>, context: ToolContext): void {
    context.policy.ensureNetworkAllowed(PERPLEXITY_SEARCH_URL, {
      toolName: this.descriptor.name,
      input: _input,
      approvals: context.approvals,
    });
  }

  public async run(
    input: z.infer<typeof PerplexitySearchInputSchema>,
    context: ToolContext,
  ): Promise<z.infer<typeof PerplexitySearchOutputSchema>> {
    this.validate(input, context);

    const apiKey = await resolveWorkspaceEnvValue("PERPLEXITY_API_KEY", context.workingDirectory);
    if (!apiKey) {
      throw new AppError("CONFIG_ERROR", "PERPLEXITY_API_KEY is not configured in process.env or the workspace .env.");
    }

    const response = await fetch(PERPLEXITY_SEARCH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        max_results: input.maxResults,
        ...(input.searchDomainFilter ? { search_domain_filter: input.searchDomainFilter } : {}),
        ...(input.searchRecencyFilter ? { search_recency_filter: input.searchRecencyFilter } : {}),
      }),
      signal: context.signal,
    });

    if (!response.ok) {
      const message = await safeReadText(response);
      throw new AppError("TOOL_ERROR", `Perplexity search failed (${response.status}): ${message}`);
    }

    const payload = PerplexitySearchResponseSchema.parse(await response.json());
    return {
      provider: "perplexity",
      query: input.query,
      ...(payload.search_id ? { searchId: payload.search_id } : {}),
      resultCount: payload.results.length,
      results: payload.results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        ...(result.date ? { date: result.date } : {}),
        ...(result.last_updated ? { lastUpdated: result.last_updated } : {}),
      })),
    };
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 0 ? text : response.statusText;
  } catch {
    return response.statusText;
  }
}
