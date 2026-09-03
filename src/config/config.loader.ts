import { promises as fs } from "fs";
import { parse } from "yaml";
import { rootConfigSchema } from "./schemas/server.schema.js";
import path from "path";
import { logger } from "../observability/logger/logger.js";

function mapBackwardCompatibleKeys(configParsed: any): any {
  if (!configParsed) return {};
  if (!configParsed.server) configParsed.server = {};

  if (configParsed.server.listen !== undefined && configParsed.server.port === undefined){
    configParsed.server.port = configParsed.server.listen;
  }
  if (!configParsed.tls){
    configParsed.tls = {};
  }
  if (configParsed.server.sslCertPath !== undefined && configParsed.tls.cert === undefined){
    configParsed.tls.cert = configParsed.server.sslCertPath;
    configParsed.tls.enabled = true;
  }
  if (configParsed.server.sslKeyPath !== undefined && configParsed.tls.key === undefined){
    configParsed.tls.key = configParsed.server.sslKeyPath;
    configParsed.tls.enabled = true;
  }
  if (configParsed.server.httpsPort !== undefined && configParsed.tls.httpsPort === undefined){
    configParsed.tls.httpsPort = configParsed.server.httpsPort;
  }

  const effectiveUpstreams = configParsed.upstreams || configParsed.server?.upstreams;
  if(effectiveUpstreams){
    configParsed.upstreams = effectiveUpstreams;
    configParsed.server.upstreams = effectiveUpstreams;
  }

  if (configParsed.server.paths !== undefined && configParsed.routes === undefined){
    configParsed.routes = configParsed.server.paths.map((p: any) => {
      const upstreams = p.upstreams || (p.upstream ? (Array.isArray(p.upstream) ? p.upstream : [p.upstream]) : []);
      return {
        path: p.path,
        upstreams,
        rateLimit: p.rateLimit,
        sticky: p.sticky,
        cache: p.cache,
      };
    });
  } else if (configParsed.routes){
    configParsed.routes = configParsed.routes.map((p: any) => {
      const upstreams = p.upstreams || (p.upstream ? (Array.isArray(p.upstream) ? p.upstream : [p.upstream]) : []);
      return {
        ...p,
        upstreams,
      };
    });
    configParsed.server.paths = configParsed.routes.map((r: any) => ({
      path: r.path,
      upstream: r.upstreams,
      rateLimit: r.rateLimit,
      sticky: r.sticky,
      cache: r.cache,
    }));
  }

  const sections = ["loadBalancing", "cache", "resilience", "rateLimit", "discovery"];
  for (const section of sections){
    if (configParsed.server[section] !== undefined && configParsed[section] === undefined){
      configParsed[section] = configParsed.server[section];
    }
  }

  if (!configParsed.observability){
    configParsed.observability = {};
  }
  if (!configParsed.observability.logging){
    configParsed.observability.logging = {};
  }
  if (configParsed.server.accessLog !== undefined && configParsed.observability.logging.accessLog === undefined){
    configParsed.observability.logging.accessLog = configParsed.server.accessLog;
  }

  if (configParsed.loadBalancing?.retry){
    if (!configParsed.resilience) configParsed.resilience = {};
    if (!configParsed.resilience.retry) configParsed.resilience.retry = {};
    configParsed.resilience.retry = {
      ...configParsed.resilience.retry,
      ...configParsed.loadBalancing.retry,
    };
  }

  if (configParsed.tenant_delivery !== undefined && configParsed.observability?.tenantDelivery === undefined){
    if (!configParsed.observability) configParsed.observability = {};
    configParsed.observability.tenantDelivery = configParsed.tenant_delivery;
  }

  return configParsed;
}

function applyEnvironmentOverrides(configParsed: any): any {
  if (!configParsed.server) configParsed.server = {};
  if (!configParsed.tls) configParsed.tls = {};
  if (!configParsed.cache) configParsed.cache = {};
  if (!configParsed.rateLimit) configParsed.rateLimit = {};
  if (!configParsed.rateLimit.redis) configParsed.rateLimit.redis = {};
  if (!configParsed.observability) configParsed.observability = {};
  if (!configParsed.observability.logging) configParsed.observability.logging = {};

  if (process.env.PORT){
    configParsed.server.port = parseInt(process.env.PORT, 10);
  }
  if (process.env.HOST){
    configParsed.server.host = process.env.HOST;
  }
  if (process.env.WORKERS){
    configParsed.server.workers = parseInt(process.env.WORKERS, 10);
  }
  if (process.env.REDIS_HOST){
    configParsed.cache.host = process.env.REDIS_HOST;
    configParsed.rateLimit.redis.host = process.env.REDIS_HOST;
  }
  if (process.env.REDIS_PORT){
    const rPort = parseInt(process.env.REDIS_PORT, 10);
    configParsed.cache.port = rPort;
    configParsed.rateLimit.redis.port = rPort;
  }
  if (process.env.LOG_LEVEL){
    configParsed.observability.logging.level = process.env.LOG_LEVEL;
  }

  return configParsed;
}

export async function parseYAMLConfig(filepath: string){
  const configFileContent = await fs.readFile(filepath, "utf-8");
  let configParsed = parse(configFileContent) || {};

  const configDir = path.join(path.dirname(filepath), "config.d");
  let dirExists = false;
  try {
    const stat = await fs.stat(configDir);
    dirExists = stat.isDirectory();
  } catch {
    dirExists = false;
  }

  if (dirExists){
    try {
      const files = await fs.readdir(configDir);
      const yamlFiles = files.filter(
        (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
      );

      const parsePromises = yamlFiles.map(async (file) => {
        const extraFilePath = path.join(configDir, file);
        try {
          const extraContent = await fs.readFile(extraFilePath, "utf-8");
          return parse(extraContent);
        } catch (err: any){
          logger.error("Config", `Skipped broken file ${file}: ${err.message}`, { file });
          return null;
        }
      });

      const parsedFilesResults = await Promise.all(parsePromises);

      for (const extraParsed of parsedFilesResults){
        if (extraParsed){
          // Merge upstreams
          const extraUps = extraParsed.upstreams || extraParsed.server?.upstreams;
          if (extraUps && Array.isArray(extraUps)){
            if (!configParsed.upstreams) configParsed.upstreams = [];
            configParsed.upstreams = [...configParsed.upstreams, ...extraUps];
          }

          // Merge routes / paths
          const extraRoutes = extraParsed.routes || extraParsed.server?.paths;
          if (extraRoutes && Array.isArray(extraRoutes)){
            if (!configParsed.routes) configParsed.routes = [];
            configParsed.routes = [...configParsed.routes, ...extraRoutes];
          }

          // Merge headers
          const extraHeaders = extraParsed.server?.headers;
          if (extraHeaders && Array.isArray(extraHeaders)){
            if (!configParsed.server) configParsed.server = {};
            if (!configParsed.server.headers) configParsed.server.headers = [];
            configParsed.server.headers = [...configParsed.server.headers, ...extraHeaders];
          }
        }
      }
    } catch (dirErr: any){
      logger.error("Config", `Error reading config.d directory: ${dirErr.message}`);
    }
  }
  configParsed = mapBackwardCompatibleKeys(configParsed);

  configParsed = applyEnvironmentOverrides(configParsed);

  return configParsed;
}

export async function validateConfig(config: any){
  try {
    return await rootConfigSchema.parseAsync(config);
  } catch (err: any){
    console.error("Configuration validation failed:\n", err.message || err);
    process.exit(1);
  }
}
