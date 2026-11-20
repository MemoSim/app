import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire('/Users/lilo-jali/Documents/Default Project/netlogo-chat/package.json');
const sharp = require('sharp');
const manifest = JSON.parse(readFileSync('/Users/lilo-jali/Documents/MemoSim Training Evidence/manifest.json', 'utf8'));
let count = 0;
for (const scenario of manifest.scenarios) for (const stage of scenario.stages) for (const shot of stage.screenshots || []) {
  const buffer = readFileSync(shot.fullPath);
  const { width, height } = await sharp(buffer).metadata();
  const scale = width / 1728;
  const crop = { left: Math.round(8 * scale), top: Math.round(95 * scale),
    width: width - Math.round(16 * scale), height: height - Math.round((95 + 112) * scale) };
  if (crop.height < 200) throw new Error('Training region unexpectedly small');
  await sharp(buffer).extract(crop).png().toFile(shot.path);
  writeFileSync(shot.path + '.crop.json', JSON.stringify({ source: shot.fullPath, output: shot.path,
    original: { width, height }, crop, statement: 'Crop only from original native capture. OS title/menu and bottom command/account-usage strip removed; no compositing, generated UI, retouching or text replacement.' }, null, 2) + '\n');
  count++;
}
console.log(JSON.stringify({ trainingCrops: count, bottomStripRemoved: true }));
