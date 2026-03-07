import {program} from 'commander' ;
import {parseYAMLConfig,validateConfig} from './config.js';
import os from 'node:os' ;
import {createServer} from './server.js';
// import http from 'http';  

async function main(){

   program.option('--config <path>');
   program.parse();

   const options = program.opts();

   if(options && 'config' in options){ 
     // if YAML file was pased then YAML files gets converted to JSON object 
       const validatedConfig = await validateConfig(await parseYAMLConfig(options.config));
       // this makes validatedConfig to an object 
      console.log(validatedConfig);
      // since createServer is pointing to interface
    await createServer({port : ( validatedConfig).server.listen , workerCount : ( validatedConfig).server.workers ?? os.cpus().length  ,
      config : validatedConfig
     });
   } 
}
// at the very first moment main function will get called 
main();