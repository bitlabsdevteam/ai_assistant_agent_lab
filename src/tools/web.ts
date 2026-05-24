import { z } from "zod";

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
    context.policy.ensureNetworkAllowed(input.url);
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
