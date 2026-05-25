import { describe, expect, it } from "vitest";

import { tokenizeArgv } from "../../src/commands/argv.js";
import { parseMCPAddArgv } from "../../src/mcp/commands.js";
import { parseSkillsAddArgv } from "../../src/skills/commands.js";

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

  it("parses repeated skills add flags from chat argv", () => {
    const parsed = parseSkillsAddArgv([
      "react-debugger",
      "--description",
      "Debug React rendering issues",
      "--trigger",
      "rerender loop",
      "--tag",
      "react",
      "--tool",
      "fs.read",
      "--tool",
      "shell.exec",
      "--disabled",
    ]);

    expect(parsed).toEqual({
      name: "react-debugger",
      scope: "project",
      description: "Debug React rendering issues",
      triggers: ["rerender loop"],
      tags: ["react"],
      tools: ["fs.read", "shell.exec"],
      disabled: true,
    });
  });
});
