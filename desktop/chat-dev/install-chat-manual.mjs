import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = '/Users/lilo-jali/Documents/MemoSim Training Evidence';
const installed = '/Applications/MemoSim.app';
const stageRoot = process.argv[2];
if (!stageRoot || existsSync(stageRoot)) throw new Error('Provide a new temporary staging directory');
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', cwd: root });
const manual = path.join(evidence, 'memosim-manual.html');
const pdf = path.join(evidence, 'MemoSim Manual.pdf');
const manifest = JSON.parse(readFileSync(path.join(evidence, 'manifest.json'), 'utf8'));
if (manifest.scenarios.length < 4 || manifest.scenarios.some(scenario => !scenario.tested || scenario.status !== 'passed')) {
  throw new Error('At least four verified chat scenarios required before installation');
}
const report = JSON.parse(readFileSync(path.join(root, 'chat-dev/chat-manual/build-report.json'), 'utf8'));
if (!Array.isArray(report.errors) || report.errors.length || report.networkRequests?.length ||
    report.actualChatScenarios !== manifest.scenarios.length || report.passedScenarios !== manifest.scenarios.length ||
    report.outputSHA256 !== createHash('sha256').update(readFileSync(manual)).digest('hex')) {
  throw new Error('Resolve manual validation failures or stale report before installation');
}
if (!readFileSync(pdf).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('PDF not generated');
let running = '';
try { running = execFileSync('pgrep', ['-fl', 'Contents/MacOS/MemoSim'], { encoding: 'utf8' }); }
catch (error) { if (error.status !== 1) throw error; }
if (running.trim()) throw new Error('All MemoSim windows must quit normally before replacement');
mkdirSync(stageRoot);
const staged = path.join(stageRoot, 'MemoSim.app');
run('ditto', [installed, staged]);
const contents = path.join(staged, 'Contents');
run('jar', ['--create', '--file', path.join(contents, 'app/01-netlogo-gui-classes.jar'), '-C', path.join(root, 'netlogo-gui/target/classes'), '.']);
cpSync(manual, path.join(contents, 'docs/memosim-manual.html'));
cpSync(pdf, path.join(contents, 'docs/manual.pdf'));
cpSync(path.join(evidence, 'base-models'), path.join(contents, 'docs/training/base-models'), { recursive: true });
cpSync(path.join(evidence, 'manifest.json'), path.join(contents, 'docs/training/evidence-manifest.json'));
for (const scenario of manifest.scenarios) {
  const folder = path.join(contents, 'docs/training/models', scenario.id);
  mkdirSync(folder, { recursive: true });
  cpSync(scenario.baseModelPath, path.join(folder, 'base.nlogox'));
  cpSync(scenario.finalModelPath, path.join(folder, 'final.nlogox'));
}
run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleVersion 1.1.4.1', path.join(contents, 'Info.plist')]);
run('codesign', ['--force', '--deep', '--sign', '-', staged]);
run('codesign', ['--verify', '--deep', '--strict', staged]);
const record = {
  product: 'MemoSim', version: '1.1.4', build: '1.1.4.1', base: 'installed 1.1.4; manual rewritten for 1.1.4',
  installedUTC: new Date().toISOString(), scenarios: manifest.scenarios.map(s => ({ id: s.id, evidenceMode: s.evidenceMode, stages: s.stages.length })),
  htmlSHA256: createHash('sha256').update(readFileSync(manual)).digest('hex'),
  pdfSHA256: createHash('sha256').update(readFileSync(pdf)).digest('hex'),
  sources: '/Users/lilo-jali/Documents/MemoSim Source Versions/1.1.4-build3-chat-manual',
  binaryPreservation: 'Only latest app retained per user instruction; transient rollback removed after verified replacement.',
};
const rollback = path.join(stageRoot, 'previous-MemoSim.app');
renameSync(installed, rollback);
try {
  renameSync(staged, installed);
  run('codesign', ['--verify', '--deep', '--strict', installed]);
} catch (error) {
  if (existsSync(installed)) renameSync(installed, staged);
  renameSync(rollback, installed);
  throw error;
}
writeFileSync(path.join(evidence, 'installed-release.json'), JSON.stringify(record, null, 2) + '\n');
rmSync(stageRoot, { recursive: true });
console.log(JSON.stringify(record, null, 2));
