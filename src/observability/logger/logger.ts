import { promises as fs, createWriteStream, type WriteStream } from "fs";
import path from "path";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface LoggerConfig {
  eventLogPath?: string | undefined;
  minLevel?: LogLevel | undefined;
}

const LEVEL_RANK: Record<LogLevel, number> = { INFO: 0, WARN: 1, ERROR: 2 };
const isTTY = process.stdout.isTTY;
const C: Record<LogLevel | "reset" | "dim", string> = isTTY
  ? {
      INFO: "\x1b[36m",
      WARN: "\x1b[33m",
      ERROR: "\x1b[31m",
      reset: "\x1b[0m",
      dim: "\x1b[2m",
    }
  : { INFO: "", WARN: "", ERROR: "", reset: "", dim: "" };

export class Logger {
  private eventLogPath?: string;
  private minLevel: LogLevel = "INFO";
  // Every access-log/event-log write used to call fs.mkdir(..., {recursive:true}) first —
  // a real syscall on every single request once access logging is on, even though the
  // directory only needs creating once per process. Cached here instead: ensure it exists
  // the first time a given resolved directory is written to, skip the check after that.
  private ensuredLogDirs = new Set<string>();

  private async ensureLogDir(dir: string): Promise<void> {
    if (this.ensuredLogDirs.has(dir)) return;
    await fs.mkdir(dir, { recursive: true });
    this.ensuredLogDirs.add(dir);
  }

  // fs.appendFile() opens, writes, and closes the file on every single call — fine for a rare
  // event-log line, real overhead once access logging (on by default) is writing one line per
  // request. A write stream opened once and reused keeps one fd open and just writes to it;
  // O_APPEND still makes each individual write() atomic, so this is exactly as safe for
  // multiple worker processes appending to the same path concurrently as the old per-call
  // open/write/close was.
  private logStreams = new Map<string, WriteStream>();
  // Root cause of the Phase G soak's ~24% access-log loss (confirmed directly: a destroyed
  // WriteStream's .write() returns false WITHOUT throwing -- the old code never checked that
  // return value and never evicted the dead stream from this map, so one transient fs error
  // (EMFILE, ENOSPC, a disk hiccup) on one worker's stream silently dropped every access-log
  // line that worker ever tried to write for the rest of the process's life, while the
  // Prometheus counter -- synchronous, in-memory, independent of this stream -- kept counting
  // normally the whole time. Self-healing here bounds the blast radius to whatever was
  // in-flight at the exact moment of the one-time error, instead of the rest of the run.
  private getLogStream(fullPath: string): WriteStream {
    let stream = this.logStreams.get(fullPath);
    if (stream && (stream.destroyed || !stream.writable)) {
      this.logStreams.delete(fullPath);
      stream = undefined;
    }
    if (!stream) {
      stream = createWriteStream(fullPath, { flags: "a" });
      stream.on("error", () => {
        this.logStreams.delete(fullPath);
      });
      this.logStreams.set(fullPath, stream);
    }
    return stream;
  }

  // process.exit() terminates immediately — any access-log/event-log line written in the same
  // tick as a graceful-drain exit may still be sitting in the WriteStream's internal buffer,
  // never having reached the fd's write() syscall, and is lost outright (confirmed directly:
  // write() + synchronous process.exit() with no event-loop turn in between can drop every
  // buffered line, not just a tail). Call this and await it before exiting a worker on purpose.
  async flushAll(): Promise<void> {
    const streams = [...this.logStreams.values()];
    this.logStreams.clear();
    await Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.end(() => resolve());
            stream.once("error", () => resolve());
          }),
      ),
    );
  }

  configure(config: LoggerConfig): void {
    if (config.eventLogPath !== undefined){
      this.eventLogPath = config.eventLogPath;
    }
    if (config.minLevel !== undefined){
      this.minLevel = config.minLevel;
    }
  }

  info(source: string, message: string, meta?: Record<string, unknown>): void {
    this._emit("INFO", source, message, meta);
  }

  warn(source: string, message: string, meta?: Record<string, unknown>): void {
    this._emit("WARN", source, message, meta);
  }

  error(source: string, message: string, meta?: Record<string, unknown>): void {
    this._emit("ERROR", source, message, meta);
  }

  // A request line is dropped (never queued at all, counted instead of silently lost) once a
  // single stream's own unwritten buffer exceeds this many bytes -- the bound exists so a
  // disk that can't keep up turns into a counted, visible drop rate instead of unbounded
  // process memory growth holding every line that's ever been written since. 8MB is roughly
  // 50-80k lines at this format's typical length, comfortably more than one sampling
  // interval's worth of traffic falling behind before it's noticed.
  private static readonly ACCESS_LOG_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

  /** Returns true if the line was queued for writing, false if it was dropped because the
   *  stream's own unwritten buffer already exceeds ACCESS_LOG_MAX_BUFFERED_BYTES -- the
   *  caller is expected to count a false return in a metric, never to drop it silently. */
  async writeAccessLog(
    logPath: string | undefined,
    clientIp: string,
    method: string,
    url: string,
    statusCode: number,
    bytesSent: number,
    latencyMs: number,
    userAgent: string,
    requestId = "-",
  ): Promise<boolean> {
    if (!logPath) return true;
    const timestamp = new Date().toISOString();
    const line =
      `${clientIp} - - [${timestamp}] "${method} ${url} HTTP/1.1" ` +
      `${statusCode} ${bytesSent} "-" "${userAgent}" ${latencyMs.toFixed(2)}ms rid=${requestId}\n`;
    try {
      const fullPath = path.resolve(logPath);
      await this.ensureLogDir(path.dirname(fullPath));
      const stream = this.getLogStream(fullPath);
      if (stream.writableLength > Logger.ACCESS_LOG_MAX_BUFFERED_BYTES) {
        return false;
      }
      stream.write(line);
      return true;
    } catch (err: any){
      this._emit("ERROR", "Logger", `Failed to write access log: ${err.message}`);
      return false;
    }
  }

  private _emit(
    level: LogLevel,
    source: string,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;

    const ts = new Date().toISOString();
    const lvl = level.padEnd(5);
    const metaStr =
      meta && Object.keys(meta).length > 0 ? " " + JSON.stringify(meta) : "";
    const termLine =
      `${C.dim}[${ts}]${C.reset} ${C[level]}[${lvl}]${C.reset}` +
      ` ${C[level]}[${source}]${C.reset} ${message}${metaStr}`;

    if (level === "ERROR"){
      process.stderr.write(termLine + "\n");
    } else {
      process.stdout.write(termLine + "\n");
    }

    if (this.eventLogPath){
      const fileLine = `[${ts}] [${lvl}] [${source}] ${message}${metaStr}\n`;
      void this._appendFile(fileLine);
    }
  }

  private async _appendFile(line: string): Promise<void> {
    if (!this.eventLogPath) return;
    try {
      const fullPath = path.resolve(this.eventLogPath);
      await this.ensureLogDir(path.dirname(fullPath));
      this.getLogStream(fullPath).write(line);
    } catch {}
  }
}
export const logger = new Logger();
export async function writeAccessLog(
  logPath: string | undefined,
  clientIp: string,
  method: string,
  url: string,
  statusCode: number,
  bytesSent: number,
  latencyMs: number,
  userAgent: string,
  requestId = "-",
): Promise<boolean> {
  return logger.writeAccessLog(
    logPath,
    clientIp,
    method,
    url,
    statusCode,
    bytesSent,
    latencyMs,
    userAgent,
    requestId,
  );
}
