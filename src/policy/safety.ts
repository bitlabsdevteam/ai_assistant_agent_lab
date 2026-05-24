const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\b/,
  /\bmv\b/,
  /\bsudo\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bterraform\b/,
  /\bkubectl\b/,
  /\bdeploy\b/i,
  /\bmigrate\b/i,
];

export function classifyCommandRisk(command: string[]): "low" | "medium" | "high" {
  const commandText = command.join(" ");
  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(commandText))) {
    return "high";
  }
  if (command[0] === "pnpm" || command[0] === "npm") {
    return "medium";
  }
  return "low";
}

export function redactSecrets(value: string): string {
  return value.replaceAll(/(api[_-]?key|token|secret)=\S+/gi, "$1=[REDACTED]");
}
