import { readFileSync, writeFileSync } from 'fs';
import { parse, stringify } from 'yaml';

function migrateConfig(inputPath: string, outputPath: string) {
  const raw = readFileSync(inputPath, 'utf-8');
  const config = parse(raw) as any;
  if (config?.server?.loadBalancing?.strategy === 'least-bandwidth') {
    console.log('Migrating: least-bandwidth -> least-connections');
    config.server.loadBalancing.strategy = 'least-connections';
  }
  writeFileSync(outputPath, stringify(config));
  console.log(`Config migrated: ${inputPath} -> ${outputPath}`);
}

migrateConfig(process.argv[2] ?? 'config.yaml', process.argv[3] ?? 'config.migrated.yaml');
