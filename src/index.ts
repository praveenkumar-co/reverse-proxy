import { program } from "commander";
import { parseYAMLConfig, validateConfig } from "./config.js";
import os from "node:os";
import { createServer, reloadServerConfig } from "./server.js";
import fs from "node:fs";

async function main() {
  program.option("--config <path>");
  program.parse();

  const options = program.opts();

  if (options && "config" in options) {
    const configPath = options.config as string;
    
    const validatedConfig = await validateConfig(
      await parseYAMLConfig(configPath)
    );
    process.on("SIGHUP", async () => {
      console.log("\n[Master] SIGHUP received — reloading configuration...");
      try {
        const rawConfig = await parseYAMLConfig(configPath);
        const newConfig = await validateConfig(rawConfig);
        await reloadServerConfig(newConfig);
        console.log("[Master] Configuration reloaded successfully!");
      } catch (err: any) {
        console.error(`[Master] Reload failed! Keeping old config. Error: ${err.message}`);
      }
    });

    console.log(validatedConfig);

    await createServer({
      port: validatedConfig.server.listen,
      workerCount: validatedConfig.server.workers ?? os.cpus().length,
      config: validatedConfig,
    });
     // praveen : i have added watcher
    let watchDebounceTimer: NodeJS.Timeout;
    fs.watch(configPath, (eventType) => {
      if (eventType === "change") {
        clearTimeout(watchDebounceTimer);
        watchDebounceTimer = setTimeout(async () => {
          console.log(`\n[Master] config.yaml changed — auto-reloading...`);
          try {
            const rawConfig = await parseYAMLConfig(configPath);
            const newConfig = await validateConfig(rawConfig);
            await reloadServerConfig(newConfig);
            console.log("[Master] Configuration reloaded automatically!");
          } catch (err: any) {
            console.error(`[Master] Auto-reload failed: ${err.message}`);
          }
        }, 100);
      }
    });
  }
}

main();