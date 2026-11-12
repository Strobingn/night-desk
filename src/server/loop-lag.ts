import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

let histogram: IntervalHistogram | null = null;

export interface EventLoopLag {
  /** Median delay, milliseconds. */
  p50Ms: number;
  /** 99th percentile delay, milliseconds. */
  p99Ms: number;
  /** Worst sample since the histogram was enabled, milliseconds. */
  maxMs: number;
}

/** Node's event-loop delay histogram. Resolution is 20ms. Measurement only. */
export function eventLoopLag(): EventLoopLag {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  }
  const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
  return {
    p50Ms: ms(histogram.percentile(50)),
    p99Ms: ms(histogram.percentile(99)),
    maxMs: ms(histogram.max)
  };
}
