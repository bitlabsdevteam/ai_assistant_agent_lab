import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildAnalyzerPromptEnvelope } from "../../src/llm/prompts.js";
import type { Settings } from "../../src/schemas.js";
import {
  addSkill,
  buildSkillTemplate,
  discoverSkillCatalog,
  selectSkills,
  validateSkillCatalog,
} from "../../src/skills/registry.js";

describe("skills registry", () => {
  it("discovers project and user skills with project precedence", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-skills-"));
    const projectRoot = path.join(workspace, ".little-helper", "skills");
    const userRoot = path.join(workspace, ".user-skills");

    await writeSkill(
      path.join(userRoot, "react-debugger", "SKILL.md"),
      buildSkillTemplate({
        name: "react-debugger",
        description: "User version",
        triggers: ["react bug"],
        tags: ["react"],
        tools: ["fs.read"],
        enabled: true,
      }),
    );
    await writeSkill(
      path.join(projectRoot, "react-debugger", "SKILL.md"),
      buildSkillTemplate({
        name: "react-debugger",
        description: "Project version",
        triggers: ["rerender loop"],
        tags: ["frontend"],
        tools: ["shell.exec"],
        enabled: true,
      }),
    );

    const catalog = await discoverSkillCatalog(createSettings(workspace, projectRoot, userRoot));

    expect(catalog.errors).toEqual([]);
    expect(catalog.skills).toHaveLength(1);
    expect(catalog.skills[0]?.scope).toBe("project");
    expect(catalog.skills[0]?.description).toBe("Project version");
  });

  it("reports duplicate names within the same scope as validation errors", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-skill-dupe-"));
    const firstProjectRoot = path.join(workspace, ".little-helper", "skills-a");
    const secondProjectRoot = path.join(workspace, ".little-helper", "skills-b");
    const userRoot = path.join(workspace, ".user-skills");

    const content = buildSkillTemplate({
      name: "postgres-tuning",
      description: "Tune Postgres queries.",
      triggers: ["slow query"],
      tags: ["postgres"],
      tools: ["fs.read"],
      enabled: true,
    });
    await writeSkill(path.join(firstProjectRoot, "postgres-tuning", "SKILL.md"), content);
    await writeSkill(path.join(secondProjectRoot, "postgres-tuning", "SKILL.md"), content);

    const report = await validateSkillCatalog({
      skillDirectories: {
        project: [firstProjectRoot, secondProjectRoot],
        user: [userRoot],
      },
    });

    expect(report.ok).toBe(false);
    expect(report.skills).toHaveLength(0);
    expect(report.errors[0]?.message).toMatch(/Duplicate skill name/);
  });

  it("scaffolds and imports skills without overwriting existing names", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-skill-add-"));
    const projectRoot = path.join(workspace, ".little-helper", "skills");
    const userRoot = path.join(workspace, ".user-skills");
    const settings = createSettings(workspace, projectRoot, userRoot);

    const scaffolded = await addSkill({
      workingDirectory: workspace,
      settings,
      scope: "project",
      name: "nextjs-ssr",
      description: "Handle Next.js SSR bugs.",
      triggers: ["hydration mismatch"],
      tags: ["nextjs"],
      tools: ["fs.read"],
      enabled: true,
    });
    expect(scaffolded.mode).toBe("scaffold");
    expect(await readFile(path.join(projectRoot, "nextjs-ssr", "SKILL.md"), "utf8")).toContain("name: nextjs-ssr");

    const sourceRoot = path.join(workspace, "imports", "postgres-tuning");
    await writeSkill(
      path.join(sourceRoot, "SKILL.md"),
      buildSkillTemplate({
        name: "postgres-tuning",
        description: "Tune Postgres queries.",
        triggers: ["slow query"],
        tags: ["postgres"],
        tools: ["shell.exec"],
        enabled: true,
      }),
    );

    const imported = await addSkill({
      workingDirectory: workspace,
      settings,
      scope: "user",
      name: "postgres-tuning",
      triggers: [],
      tags: [],
      tools: [],
      enabled: true,
      from: sourceRoot,
    });
    expect(imported.mode).toBe("import");
    expect(imported.skill.scope).toBe("user");
    await expect(
      addSkill({
        workingDirectory: workspace,
        settings,
        scope: "user",
        name: "postgres-tuning",
        triggers: [],
        tags: [],
        tools: [],
        enabled: true,
        from: sourceRoot,
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("selects explicit mentions and lexical trigger matches deterministically", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "little-helper-skill-select-"));
    const projectRoot = path.join(workspace, ".little-helper", "skills");
    const userRoot = path.join(workspace, ".user-skills");

    await writeSkill(
      path.join(projectRoot, "react-debugger", "SKILL.md"),
      buildSkillTemplate({
        name: "react-debugger",
        description: "Debug React rendering and hook issues.",
        triggers: ["rerender loop", "hooks issue"],
        tags: ["react", "frontend"],
        tools: ["fs.read", "shell.exec"],
        enabled: true,
      }),
    );
    await writeSkill(
      path.join(userRoot, "postgres-tuning", "SKILL.md"),
      buildSkillTemplate({
        name: "postgres-tuning",
        description: "Tune Postgres queries and indexes.",
        triggers: ["slow query"],
        tags: ["postgres", "sql"],
        tools: ["fs.read"],
        enabled: true,
      }),
    );
    await writeSkill(
      path.join(userRoot, "disabled-skill", "SKILL.md"),
      buildSkillTemplate({
        name: "disabled-skill",
        description: "Should never auto-select.",
        triggers: ["rerender loop"],
        tags: ["react"],
        tools: ["fs.read"],
        enabled: false,
      }),
    );

    const catalog = await discoverSkillCatalog(createSettings(workspace, projectRoot, userRoot));
    const explicit = selectSkills("use @postgres-tuning to review this query", catalog.skills);
    const automatic = selectSkills("help debug this React rerender loop", catalog.skills);

    expect(explicit.map((skill) => skill.name)).toContain("postgres-tuning");
    expect(explicit[0]?.reasons[0]?.type).toBe("explicit_handle");
    expect(automatic.map((skill) => skill.name)).toEqual(["react-debugger"]);
    expect(automatic[0]?.reasons.some((reason) => reason.type === "trigger_match")).toBe(true);
    expect(automatic.map((skill) => skill.name)).not.toContain("disabled-skill");
  });

  it("injects only selected skills into the analyzer prompt", () => {
    const prompt = buildAnalyzerPromptEnvelope(
      {
        task: "help debug this React rerender loop",
        workingDirectory: "/workspace",
        profile: "default",
        dryRun: false,
        maxIterations: 2,
        selectedSkills: [
          {
            name: "react-debugger",
            description: "Debug React rendering and hook issues.",
            triggers: ["rerender loop"],
            tags: ["react"],
            tools: ["fs.read"],
            version: 1,
            enabled: true,
            scope: "project",
            path: "/workspace/.little-helper/skills/react-debugger/SKILL.md",
            instructions: "Inspect components, state transitions, and rerender sources.",
            reasons: [
              {
                type: "trigger_match",
                detail: "Matched trigger 'rerender loop'.",
                score: 400,
              },
            ],
            totalScore: 400,
          },
        ],
        metadata: {},
      },
      [
        {
          name: "fs.read",
          description: "Read files",
          sideEffecting: false,
          category: "read",
        },
      ],
      undefined,
      {
        dryRun: false,
        permissions: ["workspace"],
        approvalMode: "on-risk",
      },
    );

    expect(prompt.visibleAppendText).toContain("react-debugger");
    expect(prompt.visibleAppendText).toContain("Inspect components, state transitions, and rerender sources.");
    expect(prompt.visibleAppendText).not.toContain("postgres-tuning");
  });
});

function createSettings(workspace: string, projectRoot: string, userRoot: string): Settings {
  return {
    env: "test",
    logLevel: "info",
    artifactDir: path.join(workspace, ".runs"),
    llmProvider: "openai",
    llmModel: "gpt-5.4",
    llmRouting: {},
    maxIterations: 2,
    approvalMode: "on-risk",
    outputFormat: "json",
    stream: false,
    maxToolOutputChars: 8_000,
    commandTimeoutMs: 30_000,
    shellAllowlist: ["node", "pnpm", "git"],
    validationCommands: [],
    allowedRoots: [workspace],
    networkAllowlist: [],
    skillDirectories: {
      project: [projectRoot],
      user: [userRoot],
    },
    mcpServers: [],
  };
}

async function writeSkill(targetPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}
