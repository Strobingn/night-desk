/** Client subscribe topics on the existing `/ws` socket. Snapshot traffic is unchanged. */

export interface TopicSocket {
  readyState: number;
  OPEN: number;
  send(data: string): void;
}

export const PUMP_TOPICS = ["pump.trades", "pump.coin", "pump.alerts", "pump.status"] as const;

export class PumpTopics {
  private readonly subs = new Map<TopicSocket, Set<string>>();

  subscribe(socket: TopicSocket, topic: string): void {
    if (!this.known(topic)) return;
    const set = this.subs.get(socket) ?? new Set<string>();
    set.add(topic);
    this.subs.set(socket, set);
  }

  unsubscribe(socket: TopicSocket, topic: string): void {
    this.subs.get(socket)?.delete(topic);
  }

  detach(socket: TopicSocket): void {
    this.subs.delete(socket);
  }

  publish(topic: string, data: unknown): void {
    const payload = JSON.stringify({ type: "pump", topic, data });
    for (const [socket, topics] of this.subs) {
      if (!topics.has(topic)) continue;
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(payload);
      } catch {
        /* closing */
      }
    }
  }

  /** `{ "op": "subscribe"|"unsubscribe", "topic": "pump.trades" }` or `topic: "pump.coin", mint`. */
  onClientMessage(socket: TopicSocket, text: string): void {
    let msg: { op?: string; type?: string; topic?: string; mint?: string };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    const op = msg.op ?? msg.type;
    if (op !== "subscribe" && op !== "unsubscribe") return;
    const topic = msg.topic === "pump.coin" && msg.mint ? `pump.coin:${msg.mint}` : msg.topic;
    if (!topic) return;
    if (op === "subscribe") this.subscribe(socket, topic);
    else this.unsubscribe(socket, topic);
  }

  private known(topic: string): boolean {
    if ((PUMP_TOPICS as readonly string[]).includes(topic)) return true;
    return topic.startsWith("pump.coin:");
  }
}
