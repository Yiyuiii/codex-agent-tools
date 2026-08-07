import { createHash } from "node:crypto";

export interface HostAcceptanceRequestIdentity {
  readonly requestIdType: "string" | "number";
  readonly requestIdSha256: string;
}

interface HostAcceptanceRequestEvent extends HostAcceptanceRequestIdentity {
  readonly type:
    | "sdkAbort"
    | "ownedExit"
    | "handlerCancelled"
    | "inFlightRemoved";
}

export type HostAcceptanceLifecycleEvent =
  | (HostAcceptanceRequestIdentity & {
      readonly type: "requestStarted";
      readonly task: "review" | "delegate";
    })
  | (HostAcceptanceRequestEvent & {
      readonly type: "sdkAbort" | "handlerCancelled" | "inFlightRemoved";
    })
  | (HostAcceptanceRequestEvent & {
      readonly type: "ownedExit";
      readonly completion: "cancelled";
      readonly ownershipDrained: true;
    });

export type HostAcceptanceEventSink = (
  event: HostAcceptanceLifecycleEvent,
) => void | Promise<void>;

const REQUEST_ID_HASH_DOMAIN =
  "codex-agent-tools/host-acceptance/request-id/v1";

export function createHostAcceptanceRequestIdentity(
  requestId: string | number,
): HostAcceptanceRequestIdentity {
  const requestIdType: HostAcceptanceRequestIdentity["requestIdType"] =
    typeof requestId === "string" ? "string" : "number";
  const requestIdSha256 = createHash("sha256")
    .update(
      `${REQUEST_ID_HASH_DOMAIN}\0${requestIdType}\0${String(requestId)}`,
      "utf8",
    )
    .digest("hex");
  return Object.freeze({ requestIdType, requestIdSha256 });
}

export function emitHostAcceptanceEvent(
  sink: HostAcceptanceEventSink | undefined,
  event: HostAcceptanceLifecycleEvent,
): void {
  if (sink === undefined) return;

  try {
    const result = sink(Object.freeze(event));
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Release-only evidence must never change the public task result.
  }
}
