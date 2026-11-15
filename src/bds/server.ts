import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type ServerState = "stopped" | "starting" | "running" | "stopping";

// scriptevent drops messages past ~2048 chars without a word, 1800 leaves room for the header
const IN_CHUNK = 1800;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  chunks: string[];
  got: number;
  timer: NodeJS.Timeout;
  op: string;
}

export class BridgeError extends Error {}

/** Makes JSON safe to pass through a command line: printable ASCII only and no spaces. */
export function encodeForCommand(value: unknown): string {
  // JSON.stringify never puts spaces or non ASCII outside strings, so escaping them is always valid JSON
  return JSON.stringify(value).replace(/[^\x21-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function chunkRequest(id: string, payload: string): string[] {
  const total = Math.max(1, Math.ceil(payload.length / IN_CHUNK));
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    out.push(`scriptevent mbm:c ${id} ${i} ${total} ${payload.slice(i * IN_CHUNK, (i + 1) * IN_CHUNK)}`);
  }
  return out;
}

/**
 * One running bedrock_server process. Talks to the bridge pack through stdin and stdout and keeps the
 * last few hundred console lines around so failures can be explained instead of guessed.
 */
export class BdsServer {
  state: ServerState = "stopped";
  private proc?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private log: string[] = [];
  private listeners = new Set<(line: string) => void>();
  private bridgeReady = false;
  readonly startedAt = Date.now();
  exitInfo?: string;

  constructor(
    readonly cwd: string,
    readonly binary = "./bedrock_server",
  ) {}

  get pid() {
    return this.proc?.pid;
  }

  get ready() {
    return this.state === "running" && this.bridgeReady;
  }

  recentLog(n = 80): string[] {
    return this.log.slice(-n);
  }

  async start(timeoutMs = 120_000): Promise<void> {
    if (this.state !== "stopped") throw new BridgeError(`server is ${this.state}`);
    this.state = "starting";
    this.bridgeReady = false;
    const proc = spawn(this.binary, [], {
      cwd: this.cwd,
      env: { ...process.env, LD_LIBRARY_PATH: "." },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (l) => this.onLine(l));
    createInterface({ input: proc.stderr }).on("line", (l) => this.onLine(`[stderr] ${l}`));
    proc.on("exit", (code, sig) => {
      this.exitInfo = `exited with ${sig ?? code}`;
      this.state = "stopped";
      this.bridgeReady = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new BridgeError(`server ${this.exitInfo} while waiting for ${p.op}`));
        this.pending.delete(id);
      }
    });
    proc.stdin.on("error", () => {});

    try {
      await this.waitForLine((l) => l.includes("MBM1 ready"), timeoutMs, () => this.state === "stopped");
    } catch (e) {
      const tail = this.recentLog(25).join("\n");
      await this.kill();
      throw new BridgeError(`${(e as Error).message}\nlast console lines:\n${tail}`);
    }
    this.state = "running";
    this.bridgeReady = true;
  }

  private onLine(line: string) {
    this.log.push(line);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    for (const f of this.listeners) f(line);
    const at = line.indexOf("MBM1 ");
    if (at < 0) return;
    const rest = line.slice(at + 5);
    const s1 = rest.indexOf(" "), s2 = rest.indexOf(" ", s1 + 1), s3 = rest.indexOf(" ", s2 + 1);
    if (s1 < 0 || s2 < 0 || s3 < 0) return;
    const id = rest.slice(0, s1);
    const seq = Number(rest.slice(s1 + 1, s2));
    const total = Number(rest.slice(s2 + 1, s3));
    const p = this.pending.get(id);
    if (!p) return;
    if (p.chunks[seq] === undefined) {
      p.chunks[seq] = rest.slice(s3 + 1);
      p.got++;
    }
    if (p.got < total) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    try {
      const msg = JSON.parse(p.chunks.join(""));
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new BridgeError(`${p.op}: ${msg.error}`));
    } catch (e) {
      p.reject(new BridgeError(`bad bridge reply for ${p.op}: ${(e as Error).message}`));
    }
  }

  waitForLine(match: (l: string) => boolean, timeoutMs: number, abort?: () => boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(check);
        this.listeners.delete(fn);
        reject(new BridgeError(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const check = setInterval(() => {
        if (abort?.()) {
          clearTimeout(timer);
          clearInterval(check);
          this.listeners.delete(fn);
          reject(new BridgeError(`server ${this.exitInfo ?? "stopped"} during startup`));
        }
      }, 200);
      const fn = (l: string) => {
        if (!match(l)) return;
        clearTimeout(timer);
        clearInterval(check);
        this.listeners.delete(fn);
        resolve(l);
      };
      this.listeners.add(fn);
    });
  }

  private write(line: string) {
    if (!this.proc || this.state === "stopped") throw new BridgeError("server is not running");
    this.proc.stdin.write(line + "\n");
  }

  /** Sends one op to the bridge pack and resolves with its result. */
  request<T = any>(op: string, args: unknown = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.ready) return Promise.reject(new BridgeError("server is not running, call server_start first"));
    const id = (this.nextId++).toString(36);
    const payload = encodeForCommand({ op, args });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`${op} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, chunks: [], got: 0, timer, op });
      try {
        for (const l of chunkRequest(id, payload)) this.write(l);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /**
   * Runs a raw console command and collects what the server prints for a moment afterwards.
   * Console output isn't tagged per command, so this is best effort and meant for things like save hold.
   */
  async console(cmd: string, opts: { until?: (l: string) => boolean; timeoutMs?: number; settleMs?: number } = {}): Promise<string[]> {
    const lines: string[] = [];
    const fn = (l: string) => lines.push(l);
    this.listeners.add(fn);
    try {
      this.write(cmd);
      if (opts.until) await this.waitForLine(opts.until, opts.timeoutMs ?? 10_000);
      else await new Promise((r) => setTimeout(r, opts.settleMs ?? 500));
    } finally {
      this.listeners.delete(fn);
    }
    return lines;
  }

  async stop(timeoutMs = 30_000): Promise<void> {
    if (this.state === "stopped" || !this.proc) return;
    this.state = "stopping";
    const proc = this.proc;
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    try {
      proc.stdin.write("stop\n");
    } catch {}
    const t = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    await exited;
    clearTimeout(t);
  }

  async kill(): Promise<void> {
    if (!this.proc || this.state === "stopped") return;
    const proc = this.proc;
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    proc.kill("SIGKILL");
    await exited;
  }
}
