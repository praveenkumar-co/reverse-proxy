import { program } from "commander";
import { parseYAMLConfig, validateConfig } from "./config/index.js";
import os from "node:os";
import { createServer, reloadServerConfig } from "./core/master.js";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./middleware/logger.js";

async function main() {
  program.option("--config <path>");
  program.parse();

  const options = program.opts();

  if (options && "config" in options) {
    const configPath = options.config as string;

    const validatedConfig = await validateConfig(
      await parseYAMLConfig(configPath),
    );

    // Configure logger with event log path from config
    logger.configure({ eventLogPath: validatedConfig.server.eventLog });
    logger.info("Bootstrap", "Config loaded", {
      listen: validatedConfig.server.listen,
      httpsPort: validatedConfig.server.httpsPort,
      workers: validatedConfig.server.workers ?? os.cpus().length,
    });

    process.on("SIGHUP", async () => {
      logger.info("Bootstrap", "SIGHUP received — reloading configuration");
      try {
        const rawConfig = await parseYAMLConfig(configPath);
        const newConfig = await validateConfig(rawConfig);
        await reloadServerConfig(newConfig);
        logger.configure({ eventLogPath: newConfig.server.eventLog });
        logger.info("Bootstrap", "Configuration reloaded successfully");
      } catch (err: any) {
        logger.error("Bootstrap", `Reload failed, keeping old config: ${err.message}`);
      }
    });

    await createServer({
      port: validatedConfig.server.listen,
      workerCount: validatedConfig.server.workers ?? os.cpus().length,
      config: validatedConfig,
    });
    // Automatic File Watcher Hot-Reload
    let watchDebounceTimer: NodeJS.Timeout;
    const triggerReload = () => {
      clearTimeout(watchDebounceTimer);
      watchDebounceTimer = setTimeout(async () => {
        try {
          const rawConfig = await parseYAMLConfig(configPath);
          const newConfig = await validateConfig(rawConfig);
          await reloadServerConfig(newConfig);
          logger.configure({ eventLogPath: newConfig.server.eventLog });
          logger.info("Bootstrap", "Configuration reloaded automatically");
        } catch (err: any) {
          logger.error("Bootstrap", `Auto-reload failed: ${err.message}`);
        }
      }, 100);
    };
    fs.watch(configPath, (eventType) => {
      if (eventType === "change") {
        triggerReload();
      }
    });
    const configDir = path.join(path.dirname(configPath), "config.d");
    if (fs.existsSync(configDir)) {
      fs.watch(configDir, () => {
        triggerReload();
      });
    }
  }
}
main();