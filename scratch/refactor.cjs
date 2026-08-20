const fs = require('fs');
const path = require('path');

// 1. Move UpstreamState
const upstreamStatePath = 'src/balancer/core/upstream-state.ts';
const upstreamTypesPath = 'src/types/upstream.types.ts';
if (fs.existsSync(upstreamStatePath)) {
  const content = fs.readFileSync(upstreamStatePath, 'utf8');
  fs.appendFileSync(upstreamTypesPath, '\n' + content);
  fs.unlinkSync(upstreamStatePath);
}

// 2. Extract LoadBalancerOptions
const lbPath = 'src/balancer/core/load-balancer.ts';
let lbContent = fs.readFileSync(lbPath, 'utf8');
const optionsRegex = /export interface LoadBalancerOptions \{[\s\S]*?\}\n/g;
const match = lbContent.match(optionsRegex);
if (match) {
  const optionsTypesPath = 'src/types/balancer.types.ts';
  fs.writeFileSync(optionsTypesPath, match[0]);
  lbContent = lbContent.replace(optionsRegex, '');
  // Add import to lbContent
  lbContent = 'import type { LoadBalancerOptions } from "../../types/balancer.types.js";\n' + lbContent;
}
// Fix UpstreamState import in lbContent
lbContent = lbContent.replace(/import type { UpstreamState } from ".\/upstream-state.js";/g, 'import type { UpstreamState } from "../../types/upstream.types.js";');
fs.writeFileSync(lbPath, lbContent);

// Fix balancer.factory.ts
const factoryPath = 'src/balancer/factory/balancer.factory.ts';
let factoryContent = fs.readFileSync(factoryPath, 'utf8');
factoryContent = factoryContent.replace(/import type { LoadBalancerOptions } from '..\/core\/load-balancer.js';/g, "import type { LoadBalancerOptions } from '../../types/balancer.types.js';");
fs.writeFileSync(factoryPath, factoryContent);


// 3. Fix strategy imports
const strategiesDir = 'src/balancer/strategies';
const files = fs.readdirSync(strategiesDir);
for (const file of files) {
  if (file.endsWith('.ts')) {
    const fullPath = path.join(strategiesDir, file);
    let content = fs.readFileSync(fullPath, 'utf8');
    content = content.replace(/import type { UpstreamState } from '\.\.\/core\/upstream-state\.js';/g, "import type { UpstreamState } from '../../types/upstream.types.js';");
    fs.writeFileSync(fullPath, content);
  }
}

// 4. Fix contracts
const strategyInterfacePath = 'src/balancer/contracts/strategy.interface.ts';
let strategyContent = fs.readFileSync(strategyInterfacePath, 'utf8');
strategyContent = strategyContent.replace(/import\("\.\.\/core\/upstream-state\.js"\)\.UpstreamState/g, 'import("../../types/upstream.types.js").UpstreamState');
fs.writeFileSync(strategyInterfacePath, strategyContent);

// 5. Update src/types/index.ts
const typesIndex = 'src/types/index.ts';
let indexContent = fs.readFileSync(typesIndex, 'utf8');
if (!indexContent.includes('balancer.types.js')) {
    indexContent += "\nexport type { LoadBalancerOptions } from './balancer.types.js';\n";
    fs.writeFileSync(typesIndex, indexContent);
}

console.log("Done refactoring");
