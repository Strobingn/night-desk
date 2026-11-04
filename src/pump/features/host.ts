/**
 * Narrow host the sniper and migration tracker talk to.
 * They never see the server signer and never send a transaction.
 */
import type { PumpConnection } from "../rpc.js";
import type { PumpSafety } from "../safety.js";
import type { PumpStore } from "../store.js";
import type { AlertEvent, AlertKind } from "../types.js";

export interface PumpFeatureHost {
  safety: PumpSafety;
  store: PumpStore;
  connection: PumpConnection;
  now(): number;
  emitAlert(input: { kind: AlertKind; mint?: string; message: string; data?: Record<string, unknown> }): AlertEvent;
  publish(topic: string, data: unknown): void;
}
