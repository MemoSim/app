import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('/Users/lilo-jali/Documents/Default Project/netlogo-chat/package.json');
const sharp = require('sharp');
const root = '/Users/lilo-jali/Documents/MemoSim Training Evidence';
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const checks = [], failures = [];
const check = (ok, label) => (ok ? checks : failures).push(label);
for (const scenario of manifest.scenarios) {
  check(scenario.tested && scenario.status === 'passed' && scenario.evidenceMode === 'actual-chat', `${scenario.id}: live chat passed`);
  check(existsSync(scenario.baseModelPath) && existsSync(scenario.finalModelPath), `${scenario.id}: model versions exist`);
  let batches = 0, shots = 0;
  for (const stage of scenario.stages) {
    check(!!stage.prompt?.trim() && Array.isArray(stage.transcript), `${scenario.id}/${stage.id}: actual prompt and transcript`);
    for (const result of stage.validation || []) check(result.ok === true, `${scenario.id}/${stage.id}: ${result.label || result.code || 'validation'}`);
    if (stage.experimentSummary) {
      const batch = stage.experimentSummary;
      check(batch.runs >= 4 && batch.terminalRows.length === batch.runs && !batch.truncated,
        `${scenario.id}/${stage.id}: complete experiment terminal rows`);
      batches++;
    }
    for (const shot of stage.screenshots || []) {
      check(shot.path !== shot.fullPath && existsSync(shot.path) && existsSync(shot.fullPath), `${scenario.id}/${stage.id}: screenshot original and crop`);
      const crop = await sharp(shot.path).metadata();
      const full = await sharp(shot.fullPath).metadata();
      check(crop.width <= full.width && crop.height < full.height && crop.width > 300 && crop.height > 150,
        `${scenario.id}/${stage.id}: cropped to training region`);
      shots++;
    }
  }
  check(batches > 0, `${scenario.id}: independently checked experiment`);
  check(shots >= 2, `${scenario.id}: creation/extension/experiment visuals recorded`);
}
const report = { generatedUTC: new Date().toISOString(), scenarios: manifest.scenarios.length, passed: checks.length,
  failed: failures.length, checks, failures };
writeFileSync(path.join(root, 'evidence-validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ scenarios: report.scenarios, passed: report.passed, failed: report.failed, failures }, null, 2));
if (failures.length) process.exitCode = 1;
