#!/usr/bin/env node
import { program } from "commander";
import { parseYAMLConfig, validateConfig } from "./config/index.js";
import os from "node:os";
import { createServer, reloadServerConfig } from "./core/cluster/master.js";
import fs from "node:fs";
import path from "node:path";
import { logger, type LogLevel } from "./observability/logger/logger.js";
import cluster from "node:cluster";
import type { RootConfigType } from "./config/schemas/server.schema.js";

// Config's `observability.logging.level` is lowercase and includes "debug", which the
// Logger doesn't distinguish from "info" (there's no finer rank below INFO) — map both down.
function toLoggerLevel(level: RootConfigType["observability"]["logging"]["level"]): LogLevel {
  switch (level) {
    case "warn":
      return "WARN";
    case "error":
      return "ERROR";
    default:
      return "INFO";
  }
}

// Exit code contract for watchdog / Docker restart policy:
//   0 → intentional shutdown (SIGTERM/SIGINT) — do NOT restart
//   1 → bad config at startup              — do NOT restart (fix config first)
//   2 → unexpected crash                   → Docker RESTARTS the container
process.on("uncaughtException", (err: Error) => {
  logger.error("Bootstrap", `Uncaught exception — ${err.message}`);
  process.exit(2);
});

process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error("Bootstrap", `Unhandled rejection — ${msg}`);
  process.exit(2);
});

async function main(){
  if(cluster.isPrimary){
    program.option("--config <path>");
    program.parse();
    const options = program.opts();
    let configPath = (options && "config" in options) ? (options.config as string) : null;
    if(!configPath){
      if(fs.existsSync("./config.yaml")){
        configPath = "./config.yaml";
      }else if (fs.existsSync("/etc/ninja-proxy/config.yaml")){
        configPath = "/etc/ninja-proxy/config.yaml";
      }else {
        logger.error("Bootstrap", "No configuration file found. Please provide --config <path>");
        process.exit(1);
      }
    }
    const validatedConfig = await validateConfig(
      await parseYAMLConfig(configPath),
    );
    logger.configure({
      eventLogPath: validatedConfig.server.eventLog,
      minLevel: toLoggerLevel(validatedConfig.observability.logging.level),
    });
    logger.info("Bootstrap", "Config loaded", {
      listen: validatedConfig.server.listen,
      httpsPort: validatedConfig.server.httpsPort,
      workers: validatedConfig.server.workers ?? os.cpus().length,
    });
    process.on("SIGHUP", async () => {
      logger.info("Bootstrap", "SIGHUP received — reloading configuration");
      try{
        const rawConfig = await parseYAMLConfig(configPath);
        const newConfig = await validateConfig(rawConfig);
        await reloadServerConfig(newConfig);
        logger.configure({
          eventLogPath: newConfig.server.eventLog,
          minLevel: toLoggerLevel(newConfig.observability.logging.level),
        });
        logger.info("Bootstrap", "Configuration reloaded successfully");
      } catch (err: any){
        logger.error("Bootstrap", `Reload failed, keeping old config: ${err.message}`);
      }
    });
    await createServer({
      port: validatedConfig.server.port ?? validatedConfig.server.listen,
      workerCount:
        validatedConfig.server.workers && validatedConfig.server.workers > 0
          ? validatedConfig.server.workers
          : os.cpus().length,
      config: validatedConfig,
    });
    let watchDebounceTimer: NodeJS.Timeout;
    let lastMtimeMs = 0;
    try { lastMtimeMs = fs.statSync(configPath).mtimeMs; } catch {}
    const triggerReload = () => {
      clearTimeout(watchDebounceTimer);
      watchDebounceTimer = setTimeout(async () => {
        try {
          const stats = fs.statSync(configPath);
          if (stats.mtimeMs <= lastMtimeMs) return;
          lastMtimeMs = stats.mtimeMs;
          const rawConfig = await parseYAMLConfig(configPath);
          const newConfig = await validateConfig(rawConfig);
          await reloadServerConfig(newConfig);
          logger.configure({
            eventLogPath: newConfig.server.eventLog,
            minLevel: toLoggerLevel(newConfig.observability.logging.level),
          });
          logger.info("Bootstrap", "Configuration reloaded automatically");
        } catch (err: any){
          logger.error("Bootstrap", `Auto-reload failed: ${err.message}`);
        }
      }, 100);
    };
    fs.watch(configPath, (eventType) => {
      if(eventType === "change"){
        triggerReload();
      }
    });
    const configDir = path.join(path.dirname(configPath), "config.d");
    if(fs.existsSync(configDir)){
      fs.watch(configDir, () => {
        triggerReload();
      });
    }
  } else {
    await import("./core/cluster/worker.js");
  }
}
main();