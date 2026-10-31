/**
 * Dependency-free observability: Prometheus text exposition (format 0.0.4)
 * and one-line JSON logs. Labels are low-cardinality by construction — routes
 * are templates ("/v1/orders/:id"), never raw paths or ids.
 */

type Labels = Record<string, string>;

const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const labelKey = (l: Labels) =>
  Object.keys(l)
    .sort()
    .map((k) => `${k}="${escapeLabel(l[k]!)}"`)
    .join(",");

interface Family {
  type: "counter" | "gauge" | "histogram";
  help: string;
}

export class Metrics {
  private families = new Map<string, Family>();
  private values = new Map<string, Map<string, number>>();
  private histograms = new Map<string, { buckets: number[]; series: Map<string, { counts: number[]; sum: number; count: number }> }>();
  private collectors: (() => void)[] = [];

  counter(name: string, help: string) {
    this.families.set(name, { type: "counter", help });
    this.values.set(name, new Map());
    return {
      inc: (labels: Labels = {}, by = 1) => {
        const m = this.values.get(name)!;
        const k = labelKey(labels);
        m.set(k, (m.get(k) ?? 0) + by);
      },
    };
  }

  gauge(name: string, help: string) {
    this.families.set(name, { type: "gauge", help });
    this.values.set(name, new Map());
    return {
      set: (value: number, labels: Labels = {}) => this.values.get(name)!.set(labelKey(labels), value),
    };
  }

  histogram(name: string, help: string, buckets: number[]) {
    this.families.set(name, { type: "histogram", help });
    const sorted = [...buckets].sort((a, b) => a - b);
    this.histograms.set(name, { buckets: sorted, series: new Map() });
    return {
      observe: (value: number, labels: Labels = {}) => {
        const h = this.histograms.get(name)!;
        const k = labelKey(labels);
        let s = h.series.get(k);
        if (!s) h.series.set(k, (s = { counts: sorted.map(() => 0), sum: 0, count: 0 }));
        sorted.forEach((b, i) => {
          if (value <= b) s!.counts[i]! += 1;
        });
        s.sum += value;
        s.count += 1;
      },
    };
  }

  /** Run before each scrape, e.g. to refresh process gauges. */
  onCollect(fn: () => void) {
    this.collectors.push(fn);
  }

  /** Read one counter/gauge series (tests and health checks). */
  value(name: string, labels: Labels = {}): number {
    return this.values.get(name)?.get(labelKey(labels)) ?? 0;
  }

  render(): string {
    for (const c of this.collectors) c();
    const out: string[] = [];
    for (const [name, f] of this.families) {
      out.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`);
      if (f.type === "histogram") {
        const h = this.histograms.get(name)!;
        for (const [k, s] of h.series) {
          const pre = k ? `${k},` : "";
          h.buckets.forEach((b, i) => out.push(`${name}_bucket{${pre}le="${b}"} ${s.counts[i]}`));
          out.push(`${name}_bucket{${pre}le="+Inf"} ${s.count}`);
          out.push(`${name}_sum${k ? `{${k}}` : ""} ${s.sum}`);
          out.push(`${name}_count${k ? `{${k}}` : ""} ${s.count}`);
        }
      } else {
        for (const [k, v] of this.values.get(name)!) out.push(`${name}${k ? `{${k}}` : ""} ${v}`);
      }
    }
    return out.join("\n") + "\n";
  }
}

export type LogFn = (entry: Record<string, unknown>) => void;

/** One JSON object per line on stdout. */
export const jsonLogger: LogFn = (entry) => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
};

/** The metric families every OICT server exposes. */
export function serverMetrics(version: string, store: string, instance: string) {
  const m = new Metrics();
  const started = Date.now();
  const build = m.gauge("oict_build_info", "Version, store kind and instance of this server (value is always 1)");
  build.set(1, { version, store, instance });
  const uptime = m.gauge("oict_process_uptime_seconds", "Seconds since this server started");
  const rss = m.gauge("oict_process_resident_memory_bytes", "Resident set size of the process");
  m.onCollect(() => {
    uptime.set((Date.now() - started) / 1000);
    rss.set(process.memoryUsage().rss);
  });
  return {
    registry: m,
    requests: m.counter("oict_http_requests_total", "HTTP requests by method, route template and status"),
    duration: m.histogram("oict_http_request_duration_seconds", "HTTP request latency by route template", [
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
    ]),
    orders: m.counter("oict_orders_total", "Order requests that returned an order, by result (created or replayed)"),
    refusals: m.counter("oict_integrity_refusals_total", "Requests refused by an OICT rule, by error code"),
  };
}
