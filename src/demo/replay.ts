import { buildDemoSteps, DEMO_LOOP_MS, type DemoStep } from "./tokens.js";
import type { Scout } from "../agents/scout.js";

export class ReplayFeed {
  private timers: NodeJS.Timeout[] = [];
  private loop: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(private readonly scout: Scout) {}

  start(): void {
    this.generation += 1;
    this.arm(this.generation);
    this.loop = setInterval(() => {
      this.generation += 1;
      this.clearTimers();
      this.arm(this.generation);
    }, DEMO_LOOP_MS);
  }

  stop(): void {
    this.generation += 1;
    this.clearTimers();
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  private arm(generation: number): void {
    for (const step of buildDemoSteps()) {
      const timer = setTimeout(() => {
        if (generation !== this.generation) return;
        this.fire(step);
      }, step.at);
      this.timers.push(timer);
    }
  }

  private fire(step: DemoStep): void {
    if (step.kind === "candidate" && step.token) {
      this.scout.publish({ ...step.token, discoveredAt: Date.now() });
      return;
    }
    if (step.kind === "tick" && step.mint && step.priceUsd) {
      this.scout.tick(step.mint, step.priceUsd);
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}
