import { readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';

function uid() { return randomBytes(6).toString('base64url').slice(0, 8); }

function rect(x, y, w, h, bg='transparent', stroke='#1e1e1e', sw=2) {
  return {
    id: uid(), type: 'rectangle', x, y, width: w, height: h, angle: 0,
    strokeColor: stroke, backgroundColor: bg, fillStyle: 'solid', strokeWidth: sw, strokeStyle: 'solid',
    roughness: 0, opacity: 100, groupIds: [], frameId: null, index: 'b' + uid(), roundness: { type: 3 },
    seed: Math.random() * 1e9 | 0, version: 1, versionNonce: Math.random() * 1e9 | 0, isDeleted: false,
    boundElements: [], updated: Date.now(), link: null, locked: false, created: null
  };
}

function txt(x, y, content, color='#1e1e1e', fontSize=13, w=null, fontFamily=3) {
  const lines = content.split('\n');
  const maxLen = Math.max(...lines.map(l => l.length));
  const height = lines.length * (fontSize * 1.35) + 12;
  const width = w || Math.max(maxLen * (fontSize * 0.62), 200);
  return {
    id: uid(), type: 'text', x, y, width, height, angle: 0,
    strokeColor: color, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, index: 'b' + uid(),
    roundness: null, seed: Math.random() * 1e9 | 0, version: 1, versionNonce: Math.random() * 1e9 | 0, isDeleted: false,
    boundElements: [], updated: Date.now(), link: null, locked: false, created: null,
    text: content, fontSize, fontFamily, textAlign: 'left', verticalAlign: 'top', containerId: null,
    originalText: content, autoResize: true, lineHeight: 1.25
  };
}

console.log("Helper functions defined successfully.");
