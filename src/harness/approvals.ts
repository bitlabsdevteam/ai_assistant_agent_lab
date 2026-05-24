import type { ArtifactStore } from "../memory/artifact-store.js";
import { ApprovalRequestSchema, type ApprovalRequest } from "../schemas.js";

export class ApprovalManager {
  private approvals: ApprovalRequest[] = [];

  public constructor(private readonly artifactStore: ArtifactStore) {}

  public async load(): Promise<ApprovalRequest[]> {
    try {
      const stored = await this.artifactStore.readJson<ApprovalRequest[]>("approvals.json");
      this.approvals = stored.map((approval) => ApprovalRequestSchema.parse(approval));
    } catch {
      this.approvals = [];
    }
    return this.snapshot();
  }

  public async add(request: ApprovalRequest): Promise<void> {
    const existing = this.approvals.find(
      (approval) =>
        approval.status === "pending" &&
        approval.toolName === request.toolName &&
        approval.inputDigest === request.inputDigest &&
        approval.stepId === request.stepId,
    );
    if (existing) {
      return;
    }
    this.approvals.push(request);
    await this.persist();
  }

  public async decide(id: string, status: "approved" | "denied"): Promise<ApprovalRequest | undefined> {
    const target = this.approvals.find((item) => item.id === id);
    if (!target) {
      return undefined;
    }
    target.status = status;
    target.decisionAt = new Date().toISOString();
    await this.persist();
    return target;
  }

  public pending(): ApprovalRequest[] {
    return this.approvals.filter((approval) => approval.status === "pending");
  }

  public approved(): ApprovalRequest[] {
    return this.approvals.filter((approval) => approval.status === "approved");
  }

  public snapshot(): ApprovalRequest[] {
    return [...this.approvals];
  }

  private async persist(): Promise<void> {
    await this.artifactStore.writeJson("approvals.json", this.approvals);
  }
}
