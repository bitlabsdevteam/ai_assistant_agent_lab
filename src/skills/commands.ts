import { AppError } from "../errors.js";
import type { OutputFormat, ResolvedSkill, SkillScope } from "../schemas.js";
import type { SkillAddResult, SkillCatalogError } from "./registry.js";

export interface ParsedSkillAddInput {
  name: string;
  scope: SkillScope;
  description?: string;
  triggers: string[];
  tags: string[];
  tools: string[];
  disabled: boolean;
  from?: string;
}

export function parseSkillsAddArgv(argv: string[]): ParsedSkillAddInput {
  const name = argv[0];
  if (!name) {
    throw new AppError("VALIDATION_ERROR", "Usage: /skills add <name> [flags]");
  }

  const parsed: ParsedSkillAddInput = {
    name,
    scope: "project",
    triggers: [],
    tags: [],
    tools: [],
    disabled: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--scope":
        parsed.scope = parseScope(requireValue(argv, ++index, token));
        break;
      case "--description":
        parsed.description = requireValue(argv, ++index, token);
        break;
      case "--trigger":
        parsed.triggers.push(requireValue(argv, ++index, token));
        break;
      case "--tag":
        parsed.tags.push(requireValue(argv, ++index, token));
        break;
      case "--tool":
        parsed.tools.push(requireValue(argv, ++index, token));
        break;
      case "--from":
        parsed.from = requireValue(argv, ++index, token);
        break;
      case "--disabled":
        parsed.disabled = true;
        break;
      default:
        throw new AppError("VALIDATION_ERROR", `Unknown skills add flag: ${token}`);
    }
  }

  if (!parsed.from && !parsed.description) {
    throw new AppError("VALIDATION_ERROR", "Scaffold mode requires --description.");
  }

  return parsed;
}

export function renderSkillsCommandHelp(): string {
  return [
    "/skills",
    "/skills list",
    "/skills inspect <name>",
    "/skills add <name> --description <text> [--scope <project|user>] [--trigger <text>] [--tag <text>] [--tool <name>] [--disabled]",
    "/skills add <name> --from <path> [--scope <project|user>]",
    "/skills validate",
  ].join("\n");
}

export function renderSkillList(skills: ResolvedSkill[], outputFormat: OutputFormat): string {
  if (outputFormat === "json") {
    return JSON.stringify(skills, null, 2);
  }
  if (skills.length === 0) {
    return "No skills installed.";
  }
  return skills
    .map(
      (skill) =>
        `${skill.name} [${skill.scope}${skill.enabled ? "" : ", disabled"}]: ${skill.description}`,
    )
    .join("\n");
}

export function renderSkillInspect(skill: ResolvedSkill, outputFormat: OutputFormat): string {
  if (outputFormat === "json") {
    return JSON.stringify(skill, null, 2);
  }
  return [
    `name: ${skill.name}`,
    `scope: ${skill.scope}`,
    `enabled: ${skill.enabled}`,
    `path: ${skill.path}`,
    `description: ${skill.description}`,
    `triggers: ${skill.triggers.join(", ") || "none"}`,
    `tags: ${skill.tags.join(", ") || "none"}`,
    `tools: ${skill.tools.join(", ") || "none"}`,
    "",
    skill.instructions,
  ].join("\n");
}

export function renderSkillAddResult(result: SkillAddResult, outputFormat: OutputFormat): string {
  if (outputFormat === "json") {
    return JSON.stringify(result, null, 2);
  }
  return `Added ${result.scope} skill '${result.skill.name}' via ${result.mode} at ${result.path}`;
}

export function renderSkillValidation(
  report: {
    ok: boolean;
    skills: ResolvedSkill[];
    errors: SkillCatalogError[];
  },
  outputFormat: OutputFormat,
): string {
  if (outputFormat === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (report.errors.length === 0) {
    return `Validated ${report.skills.length} skill(s).`;
  }
  return [
    `Validated ${report.skills.length} skill(s) with ${report.errors.length} error(s).`,
    ...report.errors.map((error) => `[${error.scope}] ${error.path}: ${error.message}`),
  ].join("\n");
}

function parseScope(value: string): SkillScope {
  if (value === "project" || value === "user") {
    return value;
  }
  throw new AppError("VALIDATION_ERROR", `Invalid skill scope: ${value}`);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new AppError("VALIDATION_ERROR", `Missing value for ${flag}`);
  }
  return value;
}
