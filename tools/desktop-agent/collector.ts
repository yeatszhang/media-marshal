import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ElectronApplication, Page } from "@playwright/test";
import { sanitizeLogValue } from "../../apps/desktop/src/logging/shared.ts";
import { atomicJson } from "./build.ts";
import { agentRunHome as runHome } from "./paths.ts";
import type { RunIdentity } from "./evidence-model.ts";
import { agentFile } from "./paths.ts";
import { projectLog } from "./log-record.ts";
import { initializeEvidence } from "./evidence-store.ts";
import { recordArtifact, recordFailure } from "./evidence-artifacts.ts";
import { reserveEvidence } from "./storage-reservation.ts";

export const trustedPage = (page: Page) => {
  try {
    const url = new URL(page.url());
    return (
      url.protocol === "marshal:" &&
      url.hostname === "app" &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};
const componentEvents = new Set([
  "core.exit",
  "sidecar.exit",
  "renderer.exit",
  "logging.dropped",
  "logging.unavailable",
  "app.stopped",
]);
export class EventCollector {
  private file: FileHandle;
  private tail = Promise.resolve();
  private pending = 0;
  private bytes = 0;
  private dropped = 0;
  private available = true;
  private closed = false;
  private pages = new WeakMap<Page, string>();
  private session: RunIdentity;
  private directory: string;
  private root: string;
  private release: (written?: number) => Promise<void> = async () => {};
  private constructor(file: FileHandle, session: RunIdentity, directory: string, root: string) {
    this.file = file;
    this.session = session;
    this.directory = directory;
    this.root = root;
  }
  static async create(root: string, session: RunIdentity) {
    await initializeEvidence(root, session);
    const release = await reserveEvidence(root, session.runId, 1024 * 1024 + 8192);
    try {
      const directory = await agentFile(root, runHome(root, session.runId)),
        file = await open(join(directory, "observations.jsonl"), "wx", 0o600);
      const collector = new EventCollector(file, { ...session }, directory, root);
      collector.release = release;
      return collector;
    } catch (error) {
      await release();
      throw error;
    }
  }
  record(event: string, fields: Record<string, unknown> = {}) {
    if (this.closed || !this.available || this.pending >= 256) {
      this.dropped++;
      return;
    }
    let line =
      JSON.stringify(
        sanitizeLogValue({
          time: new Date().toISOString(),
          sessionId: this.session.sessionId,
          runId: this.session.runId,
          buildId: this.session.buildId,
          event,
          ...fields,
        }),
      ) + "\n";
    if (Buffer.byteLength(line) > 16384) line = JSON.stringify({ event, truncated: true }) + "\n";
    const length = Buffer.byteLength(line);
    if (this.bytes + length > 1024 * 1024) {
      this.dropped++;
      return;
    }
    this.bytes += length;
    this.pending++;
    this.tail = this.tail
      .then(async () => {
        await this.file.writeFile(line);
      })
      .catch(() => {
        this.available = false;
        this.dropped++;
      })
      .finally(() => {
        this.pending--;
      });
  }
  snapshot() {
    return {
      available: this.available,
      closed: this.closed,
      pending: this.pending,
      bytes: this.bytes,
      dropped: this.dropped,
      historyComplete: false,
      path: join(this.directory, "observations.jsonl"),
    };
  }
  private page(page: Page) {
    if (this.pages.has(page)) return;
    const id = `window-${this.pagesSize++}`;
    this.pages.set(page, id);
    this.record("window.opened", { windowId: id });
    page.on("pageerror", (error) =>
      this.record(
        trustedPage(page) ? "renderer.pageerror" : "sensitive-context.unobserved",
        trustedPage(page) ? { windowId: id, error } : { windowId: id },
      ),
    );
    page.on("crash", () => {
      this.record("renderer.crashed", { windowId: id });
      this.tail = this.tail
        .then(async () => {
          await recordFailure(this.root, this.session.runId, {
            kind: "crash",
            code: "RENDERER_CRASHED",
          });
          for (const kind of ["aria", "image"] as const)
            await recordArtifact(this.root, this.session.runId, {
              kind,
              source: "dom",
              status: "missing",
              reason: "WINDOW_CRASHED",
              windowId: id,
            });
        })
        .catch(() => {
          this.available = false;
          this.dropped++;
        });
    });
    page.on("close", () => this.record("window.closed", { windowId: id }));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame())
        this.record("window.navigated", { windowId: id, observable: trustedPage(page) });
    });
  }
  private pagesSize = 1;
  attach(app: ElectronApplication) {
    app.windows().forEach((page) => this.page(page));
    app.on("window", (page) => this.page(page));
    const child = app.process();
    child.once("exit", (code, signal) => this.record("main.exited", { exitCode: code, signal }));
    const decoder = new StringDecoder("utf8");
    let buffer = "",
      dropping = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const part of decoder.write(chunk).split(/(?<=\n)/)) {
        if (!dropping) buffer += part;
        if (buffer.length > 65536) {
          buffer = "";
          if (!dropping) this.dropped++;
          dropping = true;
        }
        if (!part.endsWith("\n")) continue;
        if (!dropping) {
          try {
            const row = JSON.parse(buffer);
            if (componentEvents.has(row.event))
              this.record("component.event", { record: projectLog(row) });
          } catch {
            /* 不保留未标记控制台或原始响应。 */
          }
        }
        buffer = "";
        dropping = false;
      }
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.file.sync().catch(() => {
      this.available = false;
    });
    await this.file.close();
    try {
      await atomicJson(join(this.directory, "collector.json"), this.snapshot());
    } finally {
      await this.release(this.bytes + 8192);
    }
  }
}
