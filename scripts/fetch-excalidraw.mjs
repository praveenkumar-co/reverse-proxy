#!/usr/bin/env node
/**
 * Utility script to fetch and decrypt Excalidraw diagrams from share links.
 * Usage:
 *   node scripts/fetch-excalidraw.mjs "https://excalidraw.com/#json=<id>,<key>" [outputPath]
 */

import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";

const url = process.argv[2];
const outputPath = process.argv[3] || "docs/ninja-reverse-proxy-architecture.excalidraw";

if (!url) {
  console.error("Usage: node scripts/fetch-excalidraw.mjs <excalidraw_url> [output_file]");
  process.exit(1);
}

const match = url.match(/#json=([^,]+),(.+)$/);
if (!match) {
  console.error("Error: URL must be in format https://excalidraw.com/#json=<id>,<key>");
  process.exit(1);
}

const [, docId, keyStr] = match;
const apiUrl = `https://json.excalidraw.com/api/v2/${docId}`;

console.log(`Fetching from ${apiUrl}...`);
const response = await fetch(apiUrl);
if (!response.ok) {
  throw new Error(`Failed to fetch diagram: ${response.status} ${response.statusText}`);
}

const raw = Buffer.from(await response.arrayBuffer());

let offset = 8;
const metaLen = raw.readUInt32BE(4);
offset += metaLen;

const ivLen = raw.readUInt32BE(offset); offset += 4;
const iv = raw.subarray(offset, offset + ivLen); offset += ivLen;

const dataLen = raw.readUInt32BE(offset); offset += 4;
const encryptedBuf = raw.subarray(offset, offset + dataLen);

const tag = encryptedBuf.subarray(encryptedBuf.length - 16);
const ciphertext = encryptedBuf.subarray(0, encryptedBuf.length - 16);

let base64Key = keyStr.replace(/-/g, "+").replace(/_/g, "/");
while (base64Key.length % 4 !== 0) base64Key += "=";
const keyBuf = Buffer.from(base64Key, "base64");

const decipher = crypto.createDecipheriv("aes-128-gcm", keyBuf, iv);
decipher.setAuthTag(tag);
const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

const decompressed = zlib.inflateSync(decrypted);
const rawStr = decompressed.toString("utf8");

const firstBrace = rawStr.indexOf("{");
const lastBrace = rawStr.lastIndexOf("}");
const jsonStr = rawStr.slice(firstBrace, lastBrace + 1);

const scene = JSON.parse(jsonStr);
console.log(`Successfully decrypted ${scene.elements?.length || 0} elements!`);

fs.writeFileSync(outputPath, JSON.stringify(scene, null, 2));
console.log(`Saved updated diagram to ${outputPath}`);