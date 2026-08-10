import { promises as fs } from "fs";
import path from "path";
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
  if (!logPath) return;
  const timestamp = new Date().toISOString();
  const logLine = `${clientIp} - - [${timestamp}] "${method} ${url} HTTP/1.1" ${statusCode} ${bytesSent} "-" "${userAgent}" ${latencyMs.toFixed(2)}ms\n`;

  try {
    const fullPath = path.resolve(logPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.appendFile(fullPath, logLine, "utf8");
  } catch (err: any) {
    console.error(`[Logger] Failed to write access log: ${err.message}`);
  }
}
