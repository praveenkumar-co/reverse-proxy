import { promises as fs } from "fs";
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

  configure(config: LoggerConfig): void {
    if (config.eventLogPath !== undefined) {
      this.eventLogPath = config.eventLogPath;
    }
    if (config.minLevel !== undefined) {
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

  async writeAccessLog(
    logPath: string | undefined,
    clientIp: string,
    method: string,
    url: string,
    statusCode: number,
    bytesSent: number,
    latencyMs: number,
    userAgent: string,
  ): Promise<void> {
    if (!logPath) return;
    const timestamp = new Date().toISOString();
    const line =
      `${clientIp} - - [${timestamp}] "${method} ${url} HTTP/1.1" ` +
      `${statusCode} ${bytesSent} "-" "${userAgent}" ${latencyMs.toFixed(2)}ms\n`;
    try {
      const fullPath = path.resolve(logPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.appendFile(fullPath, line, "utf8");
    } catch (err: any) {
      this._emit("ERROR", "Logger", `Failed to write access log: ${err.message}`);
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

    if (level === "ERROR") {
      process.stderr.write(termLine + "\n");
    } else {
      process.stdout.write(termLine + "\n");
    }

    if (this.eventLogPath) {
      const fileLine = `[${ts}] [${lvl}] [${source}] ${message}${metaStr}\n`;
      void this._appendFile(fileLine);
    }
  }

  private async _appendFile(line: string): Promise<void> {
    if (!this.eventLogPath) return;
    try {
      const fullPath = path.resolve(this.eventLogPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.appendFile(fullPath, line, "utf8");
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
): Promise<void> {
  return logger.writeAccessLog(
    logPath,
    clientIp,
    method,
    url,
    statusCode,
    bytesSent,
    latencyMs,
    userAgent,
  );
}
