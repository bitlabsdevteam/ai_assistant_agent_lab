import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { AppError } from "../errors.js";
import {
  ResolvedSkillSchema,
  SkillManifestSchema,
  SkillSelectionSchema,
  type ResolvedSkill,
  type Settings,
  type SkillMatchReason,
  type SkillScope,
  type SkillSelection,
  type SkillSelectionReason,
} from "../schemas.js";

export const MAX_SELECTED_SKILLS = 3;
export const MAX_SELECTED_SKILL_CHARS = 4_500;
const AUTO_MATCH_MIN_SCORE = 30;
const EXPLICIT_HANDLE_SCORE = 1_000;
const EXPLICIT_NAME_SCORE = 900;
const TRIGGER_MATCH_SCORE = 400;
const TAG_MATCH_SCORE = 120;
const DESCRIPTION_MATCH_SCORE = 20;

export interface SkillCatalogError {
  scope: SkillScope;
  path: string;
  message: string;
}

export interface SkillCatalog {
  skills: ResolvedSkill[];
  errors: SkillCatalogError[];
}

export interface SkillAddInput {
  workingDirectory: string;
  settings: Settings;
  scope: SkillScope;
  name: string;
  description?: string;
  triggers: string[];
  tags: string[];
  tools: string[];
  enabled: boolean;
  from?: string;
}

export interface SkillAddResult {
  skill: ResolvedSkill;
  mode: "scaffold" | "import";
  scope: SkillScope;
  path: string;
}

export function resolveSkillDirectories(
  workingDirectory: string,
  homeDirectory: string,
  overrides?: Settings["skillDirectories"],
): Settings["skillDirectories"] {
  return {
    project: resolveDirectoryList(
      overrides?.project,
      [path.join(workingDirectory, ".little-helper", "skills")],
      workingDirectory,
    ),
    user: resolveDirectoryList(
      overrides?.user,
      [path.join(homeDirectory, ".config", "little-helper", "skills")],
      workingDirectory,
    ),
  };
}

export async function discoverSkillCatalog(settings: Pick<Settings, "skillDirectories">): Promise<SkillCatalog> {
  const project = await discoverSkillsInScope(settings.skillDirectories.project, "project");
  const user = await discoverSkillsInScope(settings.skillDirectories.user, "user");
  const merged = new Map<string, ResolvedSkill>();

  for (const skill of user.skills) {
    merged.set(skill.name, skill);
  }
  for (const skill of project.skills) {
    merged.set(skill.name, skill);
  }

  return {
    skills: [...merged.values()].sort(compareResolvedSkills),
    errors: [...project.errors, ...user.errors].sort((left, right) =>
      left.scope === right.scope ? left.path.localeCompare(right.path) : left.scope.localeCompare(right.scope),
    ),
  };
}

export async function getSkillByName(
  settings: Pick<Settings, "skillDirectories">,
  name: string,
): Promise<ResolvedSkill | undefined> {
  const catalog = await discoverSkillCatalog(settings);
  return catalog.skills.find((skill) => skill.name === name);
}

export async function validateSkillCatalog(
  settings: Pick<Settings, "skillDirectories">,
): Promise<{
  ok: boolean;
  skills: ResolvedSkill[];
  errors: SkillCatalogError[];
}> {
  const catalog = await discoverSkillCatalog(settings);
  return {
    ok: catalog.errors.length === 0,
    skills: catalog.skills,
    errors: catalog.errors,
  };
}

export async function addSkill(input: SkillAddInput): Promise<SkillAddResult> {
  const scopeCatalog = await discoverSkillsInScope(input.settings.skillDirectories[input.scope], input.scope);
  if (scopeCatalog.skills.some((skill) => skill.name === input.name)) {
    throw new AppError("VALIDATION_ERROR", `Skill '${input.name}' already exists in ${input.scope} scope.`);
  }

  const targetRoot = input.settings.skillDirectories[input.scope][0];
  if (!targetRoot) {
    throw new AppError("CONFIG_ERROR", `No ${input.scope} skill directory configured.`);
  }
  const targetDirectory = path.join(targetRoot, input.name);
  if (await pathExists(targetDirectory)) {
    throw new AppError("VALIDATION_ERROR", `Skill directory already exists: ${targetDirectory}`);
  }

  await mkdir(targetRoot, { recursive: true });
  if (input.from) {
    const source = path.resolve(input.workingDirectory, input.from);
    const imported = await importSkillToDirectory(source, targetDirectory, input.name, input.scope);
    return {
      skill: imported,
      mode: "import",
      scope: input.scope,
      path: imported.path,
    };
  }

  const description = input.description?.trim();
  if (!description) {
    throw new AppError("VALIDATION_ERROR", "Scaffold mode requires --description.");
  }
  await mkdir(targetDirectory, { recursive: true });
  const skillFile = path.join(targetDirectory, "SKILL.md");
  await writeFile(
    skillFile,
    buildSkillTemplate({
      name: input.name,
      description,
      triggers: input.triggers,
      tags: input.tags,
      tools: input.tools,
      enabled: input.enabled,
    }),
    "utf8",
  );
  const parsed = await loadSkillFromFile(skillFile, input.scope);
  return {
    skill: parsed,
    mode: "scaffold",
    scope: input.scope,
    path: parsed.path,
  };
}

export function selectSkills(task: string, skills: ResolvedSkill[]): SkillSelection[] {
  const enabledSkills = skills.filter((skill) => skill.enabled);
  const rawMatches = enabledSkills
    .map((skill) => scoreSkill(task, skill))
    .filter((selection): selection is SkillSelection => selection !== undefined)
    .sort(compareSelectedSkills);

  const selected: SkillSelection[] = [];
  let promptChars = 0;
  for (const match of rawMatches) {
    if (selected.length >= MAX_SELECTED_SKILLS) {
      break;
    }
    const estimatedChars = estimateSkillPromptChars(match);
    if (selected.length > 0 && promptChars + estimatedChars > MAX_SELECTED_SKILL_CHARS) {
      continue;
    }
    selected.push(SkillSelectionSchema.parse(match));
    promptChars += estimatedChars;
  }
  return selected;
}

export function buildSkillTemplate(input: {
  name: string;
  description: string;
  triggers: string[];
  tags: string[];
  tools: string[];
  enabled: boolean;
}): string {
  const triggers = input.triggers.length > 0 ? input.triggers : ["describe when this skill should trigger"];
  const tags = input.tags.length > 0 ? input.tags : ["replace-me"];
  const tools = input.tools.length > 0 ? input.tools : ["fs.read"];
  return [
    "---",
    `name: ${input.name}`,
    `description: ${escapeYamlScalar(input.description)}`,
    "triggers:",
    ...triggers.map((entry) => `  - ${escapeYamlScalar(entry)}`),
    "tags:",
    ...tags.map((entry) => `  - ${escapeYamlScalar(entry)}`),
    "tools:",
    ...tools.map((entry) => `  - ${escapeYamlScalar(entry)}`),
    "version: 1",
    `enabled: ${input.enabled ? "true" : "false"}`,
    "---",
    "Use this skill when the task matches the triggers above.",
    "",
    "Recommended workflow:",
    "1. Inspect the relevant files and current behavior.",
    "2. Apply only the smallest changes needed for the task.",
    "3. Verify the result with focused checks before replying.",
    "",
    "Project-specific notes:",
    "- Add any conventions, risks, or validation steps here.",
  ].join("\n");
}

export function summarizeSkillSelection(selection: SkillSelection): string {
  return selection.reasons.map((reason) => reason.detail).join("; ");
}

async function discoverSkillsInScope(directories: string[], scope: SkillScope): Promise<SkillCatalog> {
  const resolved: ResolvedSkill[] = [];
  const errors: SkillCatalogError[] = [];

  for (const rootDirectory of directories) {
    const entries = await listDirectoryEntries(rootDirectory);
    for (const entry of entries) {
      const candidate = path.join(rootDirectory, entry, "SKILL.md");
      if (!(await pathExists(candidate))) {
        continue;
      }
      try {
        resolved.push(await loadSkillFromFile(candidate, scope));
      } catch (error) {
        errors.push({
          scope,
          path: candidate,
          message: error instanceof Error ? error.message : "Unknown skill parse failure.",
        });
      }
    }
  }

  const duplicates = new Map<string, ResolvedSkill[]>();
  for (const skill of resolved) {
    const existing = duplicates.get(skill.name) ?? [];
    existing.push(skill);
    duplicates.set(skill.name, existing);
  }

  const deduped = resolved.filter((skill) => {
    const entries = duplicates.get(skill.name) ?? [];
    if (entries.length <= 1) {
      return true;
    }
    errors.push({
      scope,
      path: skill.path,
      message: `Duplicate skill name '${skill.name}' discovered in ${scope} scope.`,
    });
    return false;
  });

  return {
    skills: deduped.sort(compareResolvedSkills),
    errors,
  };
}

async function loadSkillFromFile(filePath: string, scope: SkillScope): Promise<ResolvedSkill> {
  const raw = await readFile(filePath, "utf8");
  const { manifest, instructions } = parseSkillDocument(raw);
  return ResolvedSkillSchema.parse({
    ...manifest,
    instructions,
    scope,
    path: filePath,
  });
}

function parseSkillDocument(document: string): { manifest: z.infer<typeof SkillManifestSchema>; instructions: string } {
  const trimmed = document.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    throw new AppError("VALIDATION_ERROR", "SKILL.md must start with YAML frontmatter.");
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new AppError("VALIDATION_ERROR", "SKILL.md must start with a frontmatter delimiter.");
  }
  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex < 0) {
    throw new AppError("VALIDATION_ERROR", "SKILL.md frontmatter is missing a closing delimiter.");
  }

  const frontmatter = parseSimpleYaml(lines.slice(1, closingIndex));
  const manifest = SkillManifestSchema.parse(frontmatter);
  const instructions = lines.slice(closingIndex + 1).join("\n").trim();
  if (instructions.length === 0) {
    throw new AppError("VALIDATION_ERROR", "SKILL.md must include Markdown instructions after the frontmatter.");
  }
  return { manifest, instructions };
}

function parseSimpleYaml(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | undefined;
  let currentList: unknown[] | undefined;

  const flushList = (): void => {
    if (currentKey && currentList) {
      result[currentKey] = currentList;
    }
    currentKey = undefined;
    currentList = undefined;
  };

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch) {
      if (!currentKey || !currentList) {
        throw new AppError("VALIDATION_ERROR", `Invalid YAML list item: ${line}`);
      }
      currentList.push(parseScalar(listMatch[1]!));
      continue;
    }

    flushList();
    const keyValueMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
    if (!keyValueMatch) {
      throw new AppError("VALIDATION_ERROR", `Unsupported YAML line: ${line}`);
    }
    const key = keyValueMatch[1]!;
    const rawValue = keyValueMatch[2];
    if (rawValue === undefined || rawValue.length === 0) {
      currentKey = key;
      currentList = [];
      continue;
    }
    result[key] = parseScalar(rawValue);
  }

  flushList();
  return result;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => parseScalar(entry));
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function importSkillToDirectory(
  sourcePath: string,
  targetDirectory: string,
  expectedName: string,
  scope: SkillScope,
): Promise<ResolvedSkill> {
  if (!(await pathExists(sourcePath))) {
    throw new AppError("NOT_FOUND", `Skill import source not found: ${sourcePath}`);
  }

  const sourceStat = await stat(sourcePath);
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "little-helper-skill-import-"));
  try {
    const tempTarget = path.join(tempDirectory, "skill");
    if (sourceStat.isDirectory()) {
      await cp(sourcePath, tempTarget, { recursive: true, errorOnExist: true });
    } else {
      await mkdir(tempTarget, { recursive: true });
      const sourceName = path.basename(sourcePath);
      if (sourceName !== "SKILL.md") {
        throw new AppError("VALIDATION_ERROR", "Imported skill file must be named SKILL.md.");
      }
      await cp(sourcePath, path.join(tempTarget, "SKILL.md"), { errorOnExist: true });
    }

    const parsed = await loadSkillFromFile(path.join(tempTarget, "SKILL.md"), scope);
    if (parsed.name !== expectedName) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Imported skill name '${parsed.name}' does not match requested name '${expectedName}'.`,
      );
    }
    await cp(tempTarget, targetDirectory, { recursive: true, errorOnExist: true });
    return await loadSkillFromFile(path.join(targetDirectory, "SKILL.md"), scope);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function scoreSkill(task: string, skill: ResolvedSkill): SkillSelection | undefined {
  const reasons: SkillSelectionReason[] = [];
  const lowerTask = task.toLowerCase();
  const normalizedTask = normalizeText(task);
  const taskTokens = new Set(tokenize(normalizedTask));

  if (matchesHandle(lowerTask, skill.name)) {
    reasons.push({
      type: "explicit_handle",
      detail: `Matched explicit handle @${skill.name}.`,
      score: EXPLICIT_HANDLE_SCORE,
    });
  }
  if (matchesPhrase(normalizedTask, normalizeText(skill.name))) {
    reasons.push({
      type: "explicit_name",
      detail: `Matched explicit skill name '${skill.name}'.`,
      score: EXPLICIT_NAME_SCORE,
    });
  }

  for (const trigger of skill.triggers) {
    const normalizedTrigger = normalizeText(trigger);
    if (normalizedTrigger.length > 0 && matchesPhrase(normalizedTask, normalizedTrigger)) {
      reasons.push({
        type: "trigger_match",
        detail: `Matched trigger '${trigger}'.`,
        score: TRIGGER_MATCH_SCORE,
      });
    }
  }

  for (const tag of skill.tags) {
    const normalizedTag = normalizeText(tag);
    if (normalizedTag.length > 0 && matchesPhrase(normalizedTask, normalizedTag)) {
      reasons.push({
        type: "tag_match",
        detail: `Matched tag '${tag}'.`,
        score: TAG_MATCH_SCORE,
      });
    }
  }

  const overlap = [...new Set([...tokenize(normalizeText(skill.name)), ...tokenize(normalizeText(skill.description))])].filter(
    (token) => token.length > 2 && taskTokens.has(token),
  );
  if (overlap.length > 0) {
    reasons.push({
      type: "description_match",
      detail: `Matched description/name tokens: ${overlap.join(", ")}.`,
      score: overlap.length * DESCRIPTION_MATCH_SCORE,
    });
  }

  if (reasons.length === 0) {
    return undefined;
  }

  const totalScore = reasons.reduce((sum, reason) => sum + reason.score, 0);
  const explicit = reasons.some((reason) => reason.type === "explicit_handle" || reason.type === "explicit_name");
  if (!explicit && totalScore < AUTO_MATCH_MIN_SCORE) {
    return undefined;
  }

  return SkillSelectionSchema.parse({
    ...skill,
    reasons: reasons.sort((left, right) => right.score - left.score || left.type.localeCompare(right.type)),
    totalScore,
  });
}

function estimateSkillPromptChars(skill: Pick<ResolvedSkill, "name" | "description" | "instructions" | "tools">): number {
  return skill.name.length + skill.description.length + skill.instructions.length + skill.tools.join(", ").length + 128;
}

function compareResolvedSkills(left: ResolvedSkill, right: ResolvedSkill): number {
  if (left.scope !== right.scope) {
    return left.scope === "project" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function compareSelectedSkills(left: SkillSelection, right: SkillSelection): number {
  if (left.totalScore !== right.totalScore) {
    return right.totalScore - left.totalScore;
  }
  if (left.scope !== right.scope) {
    return left.scope === "project" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(input: string): string[] {
  return input.split(/\s+/).filter((token) => token.length > 0);
}

function matchesPhrase(normalizedTask: string, normalizedPhrase: string): boolean {
  if (normalizedPhrase.length === 0) {
    return false;
  }
  return ` ${normalizedTask} `.includes(` ${normalizedPhrase} `);
}

function matchesHandle(task: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9-])@${escaped}(?=$|[^a-z0-9-])`, "i").test(task);
}

function escapeYamlScalar(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function resolveDirectoryList(value: string[] | undefined, fallback: string[], workingDirectory: string): string[] {
  const source = value && value.length > 0 ? value : fallback;
  return [...new Set(source.map((entry) => (path.isAbsolute(entry) ? entry : path.join(workingDirectory, entry))))];
}

async function listDirectoryEntries(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
