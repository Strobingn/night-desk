/**
 * Desk report PNG and navigator.share. The share sheet receives one PNG file.
 * Callers can inject `share` in tests; the browser path uses navigator.share.
 */
export interface ReportCopy {
  title: string;
  text: string;
}

export interface ReportShareData {
  title: string;
  text: string;
  files: unknown[];
}

interface PaintCtx {
  fillStyle: unknown;
  font: string;
  textBaseline: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
}

interface PaintCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): PaintCtx | null;
}

export function paintDeskReport(canvas: PaintCanvas, lines: readonly string[]): void {
  canvas.width = 880;
  canvas.height = Math.max(360, 48 + lines.length * 36);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#0a0e12";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#22d3ee";
  ctx.fillRect(0, 0, canvas.width, 8);
  ctx.fillStyle = "#f7f7f7";
  ctx.font = "600 22px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  lines.forEach((line, index) => ctx.fillText(line, 32, 28 + index * 36));
}

type PngBlob = { arrayBuffer(): Promise<ArrayBuffer> };

export async function canvasPng(canvas: PaintCanvas & { toBlob?: (cb: (blob: PngBlob | null) => void, type?: string) => void }): Promise<Uint8Array | null> {
  if (!canvas.toBlob) return null;
  const blob = await new Promise<PngBlob | null>((resolve) => canvas.toBlob?.(resolve, "image/png"));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

export async function shareDeskReport(bytes: Uint8Array, copy: ReportCopy, share?: (data: ReportShareData) => Promise<void>): Promise<void> {
  const ctor = (globalThis as { File?: new (parts: Uint8Array[], name: string, opts: { type: string }) => unknown }).File;
  if (!ctor) throw new Error("File is not available.");
  const file = new ctor([bytes], "desk-report.png", { type: "image/png" });
  const payload: ReportShareData = { title: copy.title, text: copy.text, files: [file] };
  const fn = share ?? browserShare;
  await fn(payload);
}

function browserShare(data: ReportShareData): Promise<void> {
  const nav = (globalThis as { navigator?: { share?: (value: ReportShareData) => Promise<void> } }).navigator;
  if (typeof nav?.share !== "function") return Promise.reject(new Error("navigator.share is not available"));
  return nav.share(data);
}
