import { promises as fs } from 'fs';
import { parse } from 'yaml';  
import {rootConfigSchema} from "./config-schema.js";

export async function parseYAMLConfig(filepath : string){
   const configFileContent = await fs.readFile(filepath ,'utf-8');
   const configParsed = parse(configFileContent); 
   return JSON.stringify(configParsed);
}

export async function validateConfig(config : string){
   const validateSchema = await rootConfigSchema.parseAsync(JSON.parse(config));
   return validateSchema ;
}