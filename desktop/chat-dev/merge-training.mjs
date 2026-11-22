import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
const root = process.argv.slice(2).find(argument => !argument.startsWith('--')) || '/Users/lilo-jali/Documents/MemoSim Training Evidence';
const expected = ['ecology-sir', 'manufacturing-queue', 'economics-wealth', 'policy-renewables', 'psychology-opinions', 'ai-bandit'];
const teaching = {
  'ecology-sir': { title: 'Public health · from infection to vaccination', discipline: 'Biology & public health', goal: 'Create a small susceptible–infected–recovered model from chat, add vaccination without losing population accounting, and compare policy settings in a local batch.', interpretation: 'This is a classroom mechanism model, not a calibrated disease forecast. Check that susceptible, infected and recovered counts sum to the population; compare repeated scenarios rather than treating one run as a prediction.' },
  'manufacturing-queue': { title: 'Manufacturing · is a second server worth it?', discipline: 'Manufacturing & operations', goal: 'Open the queue starter, ask chat to add a server-count control, then compare one and two servers with the same arrival and service assumptions.', interpretation: 'Read throughput, waiting time and queue length together. Confirm arrived minus completed minus jobs in the system stays zero; a shorter queue alone is not proof that the process became more efficient.' },
  'economics-wealth': { title: 'Economics · saving and the distribution of wealth', discipline: 'Economics', goal: 'Open a pairwise-exchange starter, ask for a saving mechanism and its control, then compare saving settings while checking that total wealth is conserved.', interpretation: 'This exchange model illustrates a mechanism, not an empirical economy. Conservation checks catch accidental creation or loss of money; compare distributions across seeds before drawing conclusions.' },
  'policy-renewables': { title: 'Policy · incentives and renewable adoption', discipline: 'Policy & environment', goal: 'Open the adoption starter, ask chat to add a subsidy control and incorporate it into the adoption rule, then compare incentives in a repeated experiment.', interpretation: 'Adoption probability is a stylized behavioral rule. Check population and adoption bounds. A simulated subsidy effect is conditional on that rule and is not a causal estimate from real policy data.' },
  'psychology-opinions': { title: 'Psychology · how quickly do opinions converge?', discipline: 'Psychology & social dynamics', goal: 'Open the bounded-confidence starter, ask chat to introduce an adjustment-rate control, then compare learning speeds while preserving opinion bounds.', interpretation: 'Agents interact only within the confidence rule. Compare dispersion and cluster patterns rather than claiming that a lower variance proves consensus in real people.' },
  'ai-bandit': { title: 'AI · when should exploration decay?', discipline: 'AI & learning', goal: 'Open a fixed-reward epsilon-greedy bandit starter, ask for a switch that makes exploration decay over time, then compare strategies with a reproducible local batch.', interpretation: 'The reward probabilities remain fixed and value estimates use sample averages. The added feature decays exploration; it is not reward forgetting or a changing environment. Reward randomness can mask differences in short runs; one seed does not establish general superiority.' },
};
function batchSummary(validation) {
  const batches = (Array.isArray(validation) ? validation : []).filter(check => check.ok && check.actual?.columns && check.actual?.rows);
  if (!batches.length) return undefined;
  const batch = batches.at(-1).actual;
  const runIndex = batch.columns.indexOf('[run number]');
  const stepIndex = batch.columns.findIndex(column => column === '[step]' || column === 'ticks');
  if (runIndex < 0 || stepIndex < 0) return undefined;
  const final = new Map();
  for (const row of batch.rows) {
    const previous = final.get(row[runIndex]);
    if (!previous || Number(row[stepIndex]) >= Number(previous[stepIndex])) final.set(row[runIndex], row);
  }
  return { runs: batch.runs, totalRows: batch.rows.length, truncated: !!batch.truncated,
    columns: batch.columns, terminalRows: [...final.values()].sort((a, b) => Number(a[runIndex]) - Number(b[runIndex])),
    caption: 'Actual terminal-step records selected from the captured per-step experiment output. These are recorded results, not illustrative values.' };
}
const scenarios = new Map();
const attempts = [];
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(root, entry.name, 'manifest.json');
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  for (const scenario of manifest.scenarios || []) {
    attempts.push({ id: scenario.id, status: scenario.status, tested: scenario.tested, path: path.relative(root, file) });
    if (!scenario.tested || scenario.status !== 'passed') continue;
    const existing = scenarios.get(scenario.id);
    if (existing && existing.generatedAt > manifest.generatedAt) continue;
    const samplingNotice = 'This build records metrics at every step. A chat statement requesting or claiming end-only recording does not change that setting. Compare the actual terminal-step records; the complete raw series is retained.';
    const lesson = teaching[scenario.id];
    scenarios.set(scenario.id, { ...scenario, ...(lesson || {}), generatedAt: manifest.generatedAt, sourceManifest: file,
      limitations: [...(scenario.limitations || []), samplingNotice],
      stages: scenario.stages.map(stage => {
        const experimentSummary = batchSummary(stage.validation);
        const brokenExport = scenario.id === 'ecology-sir' && stage.id === '03-ecology-sir';
        return { ...stage, experimentSummary,
          ...(brokenExport ? { modelDownloadStatus: 'broken-checkpoint',
            limitations: [...(stage.limitations || []), 'Historical checkpoint: the live vaccination checks passed, but this saved export has blank Code and cannot run standalone. Do not use it as a starter. The next recorded chat stage discovers and repairs the missing Code; use the final model after fresh-file validation.'],
          } : {}), ...(/experiment|batch/i.test(stage.title || stage.prompt || '')
          ? { limitations: [...(stage.limitations || []), samplingNotice] } : {}) };
      }),
    });
  }
}
const ordered = expected.filter(id => scenarios.has(id)).map(id => scenarios.get(id));
const missing = expected.filter(id => !scenarios.has(id));
const manifest = {
  schemaVersion: 1, appVersion: '1.1.4', generatedAt: new Date().toISOString(), scenarios: ordered,
  statusReport: [
    ...ordered.map(scenario => ({ title: scenario.title, status: 'passed', detail: `Actual chat with recorded tool calls, native model outputs and independent checks. Source: ${path.relative(root, scenario.sourceManifest)}` })),
    ...missing.map(id => ({ title: id, status: 'pending', detail: 'Not included as a tested lesson until its actual chat workflow passes.' })),
    { title: 'Experiment deployment', status: 'scope', detail: 'Deployment in these lessons means defining and executing a local BehaviorSpace batch in MemoSim. Cloud scheduling or public web publication is not implemented or claimed.' },
    { title: 'Experiment recording', status: 'limitation', detail: 'This build serializes metrics at every step, even if chat asks for end-only sampling. Use the recorded terminal-step rows to compare final outcomes; full per-step rows remain in the evidence.' },
    { title: 'Reproducibility', status: 'scope', detail: 'Captured prompts demonstrate one tested run using the configured model/provider. Other providers and stochastic runs may differ. Check compiler feedback, invariants and actual experiment records.' },
  ],
  attempts,
};
writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ passed: ordered.map(s => s.id), missing, attempts: attempts.length }));
if (process.argv.includes('--require-all') && missing.length) process.exitCode = 1;
