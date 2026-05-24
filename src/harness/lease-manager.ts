import type { HarnessRunState } from "../schemas.js";

export class LeaseManager {
  public acquire(state: HarnessRunState, owner = process.pid.toString(), ttlMs = 30_000): HarnessRunState {
    return {
      ...state,
      leaseOwner: owner,
      leaseExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };
  }

  public renew(state: HarnessRunState, ttlMs = 30_000): HarnessRunState {
    return {
      ...state,
      leaseExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };
  }

  public hasExpired(state: HarnessRunState): boolean {
    return state.leaseExpiresAt !== undefined && Date.parse(state.leaseExpiresAt) <= Date.now();
  }
}
