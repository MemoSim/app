import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const require = createRequire('/Users/lilo-jali/Documents/Default Project/netlogo-chat/package.json');
const sharp = require('sharp');
const [source, output, mode = 'workspace'] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: node chat-dev/crop-training.mjs full.png cropped.png [workspace|chat]');
const buffer = readFileSync(source);
const metadata = await sharp(buffer).metadata();
const width = metadata.width, height = metadata.height;
if (!width || !height || width < 400 || height < 300) throw new Error('Screenshot dimensions too small for native training crop');
// Native frame bounds from /window-state: discard OS title/menu and bottom command strip.
const scale = width / 1728;
const left = mode === 'chat' ? Math.max(0, width - Math.round(460 * scale)) : Math.round(8 * scale);
const top = Math.round((mode === 'chat' ? 108 : 95) * scale);
const crop = { left, top, width: width - left - Math.round(8 * scale), height: height - top - Math.round(34 * scale) };
if (crop.width < 100 || crop.height < 100) throw new Error('Invalid crop geometry');
mkdirSync(path.dirname(output), { recursive: true });
await sharp(buffer).extract(crop).png().toFile(output);
writeFileSync(output + '.crop.json', JSON.stringify({ source, output, mode, original: { width, height }, crop,
  statement: 'Crop only; no generated UI, compositing, retouching or text replacement.' }, null, 2) + '\n');
console.log(JSON.stringify({ output, ...crop }));
