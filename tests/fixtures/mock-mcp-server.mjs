import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const request = JSON.parse(line);

  if (request.method === "discover") {
    process.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo MCP input back to the caller.",
              riskLevel: "low",
              sideEffecting: false,
              requiresApproval: false,
              permissionScope: "read-only",
            },
          ],
          resources: [
            {
              uri: "mock://docs/intro",
              name: "intro",
              description: "Mock documentation resource",
            },
          ],
          resourceTemplates: [
            {
              uriTemplate: "mock://docs/{slug}",
              name: "docs-template",
              description: "Mock docs template",
            },
          ],
        },
      })}\n`,
    );
    rl.close();
    return;
  }

  if (request.method === "invoke_tool") {
    process.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: {
          echoed: request.params.input,
        },
      })}\n`,
    );
    rl.close();
    return;
  }

  if (request.method === "read_resource") {
    process.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: {
          uri: request.params.uri,
          body: "Mock resource body",
        },
      })}\n`,
    );
    rl.close();
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      id: request.id,
      error: `Unsupported method: ${request.method}`,
    })}\n`,
  );
  rl.close();
});
