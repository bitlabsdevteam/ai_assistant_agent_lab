import { describe, expect, it } from "vitest";

import { tokenizeArgv } from "../../src/commands/argv.js";
import { parseMCPAddArgv } from "../../src/mcp/commands.js";

describe("argv tokenization", () => {
  it("supports quoted values for slash commands", () => {
    expect(tokenizeArgv('/mcp add myserver --command npx --arg "./folder with spaces" --arg test')).toEqual([
      "/mcp",
      "add",
      "myserver",
      "--command",
      "npx",
      "--arg",
      "./folder with spaces",
      "--arg",
      "test",
    ]);
  });

  it("parses repeated mcp add flags from chat argv", () => {
    const parsed = parseMCPAddArgv([
      "myserver",
      "--command",
      "npx",
      "--arg",
      "-y",
      "--arg",
      "@modelcontextprotocol/server-filesystem",
      "--arg",
      "./src",
      "--allow-tool",
      "echo",
      "--allow-tool",
      "read",
    ]);

    expect(parsed).toMatchObject({
      name: "myserver",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./src"],
      allowedTools: ["echo", "read"],
    });
  });
});
