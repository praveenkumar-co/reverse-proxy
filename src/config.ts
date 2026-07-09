import { promises as fs } from 'fs';
import { parse } from 'yaml';  
import {rootConfigSchema} from "./config-schema.js";
import path from 'path';
   
export async function parseYAMLConfig(filepath : string){
   const configFileContent = await fs.readFile(filepath ,'utf-8');
   const configParsed = parse(configFileContent) || {}; 
   if (!configParsed.server) {
      configParsed.server = {};
   }
   const configDir = path.join(path.dirname(filepath), "config.d");
   let dirExists = false;
   try {
      const stat = await fs.stat(configDir);
      dirExists = stat.isDirectory();
   } catch {
      dirExists = false;
   }

   if (dirExists) {
      try {
         const files = await fs.readdir(configDir);
         for (const file of files) {
            if (file.endsWith(".yaml") || file.endsWith(".yml")) {
               const extraFilePath = path.join(configDir, file);
               try {
                  const extraContent = await fs.readFile(extraFilePath, "utf-8");
                  const extraParsed = parse(extraContent);

                  if (extraParsed && extraParsed.server) {
                     if (extraParsed.server.upstreams && Array.isArray(extraParsed.server.upstreams)) {
                        configParsed.server.upstreams = [
                           ...(configParsed.server.upstreams || []),
                           ...extraParsed.server.upstreams
                        ];
                     }
                     if (extraParsed.server.paths && Array.isArray(extraParsed.server.paths)) {
                        configParsed.server.paths = [
                           ...(configParsed.server.paths || []),
                           ...extraParsed.server.paths
                        ];
                     }
                     if (extraParsed.server.headers && Array.isArray(extraParsed.server.headers)) {
                        configParsed.server.headers = [
                           ...(configParsed.server.headers || []),
                           ...extraParsed.server.headers
                        ];
                     }
                  }
               } catch (err: any) {
                  console.error(`[Config] Skipped loading broken file ${file}: ${err.message}`);
               }
            }
         }
      } catch (dirErr: any) {
         console.error(`[Config] Error reading config.d directory: ${dirErr.message}`);
      }
   }

   return configParsed ;
}

export async function validateConfig(config: any) {
  return await rootConfigSchema.parseAsync(config);
}