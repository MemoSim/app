import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const destination = process.argv[2];
if (!destination || existsSync(destination)) throw new Error('Provide a new, version-specific source archive directory');
const repositories = {
  desktop: '/Users/lilo-jali/dev/netlogo-desktop',
  assistant: '/Users/lilo-jali/Documents/Default Project/netlogo-chat',
};
mkdirSync(destination, { recursive: true });
const manifest = { createdUTC: new Date().toISOString(), sourceState: 'Working-tree snapshot including preexisting uncommitted changes, not a clean checkout', excluded: ['Secrets and .env/config files', 'Ignored caches, dependencies and build output', 'Packaged app installers'], repositories: {} };
for (const [name, directory] of Object.entries(repositories)) {
  const git = args => execFileSync('git', args, { cwd: directory, maxBuffer: 64 * 1024 * 1024 });
  const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean))]
    .filter(relative => /(?:^|\/)\.env\.(?:example|sample|template)$/.test(relative) ||
      !/(^|\/)(\.env(?:\..*)?|config\.env|\.settings-key|.*(?:private[-_]?key|credentials).*|app\.db(?:-wal|-shm)?)$/i.test(relative))
    .filter(relative => !/\.(?:app|dmg|pkg)(?:\/|$)/i.test(relative))
    .filter(relative => !/(^|\/)(?:node_modules|target|dist|\.next(?:-app)?|\.git|webview|coverage|playwright-report|test-results|logs?|user-data|app-data)(?:\/|$)/i.test(relative))
    .filter(relative => !/\.(?:jar|class|db|sqlite|sqlite3|log|pem|p12|pfx|key|jks|keystore|wasm|dylib|so|dll|exe|zip|tar|gz)(?:-wal|-shm)?$/i.test(relative))
    .filter(relative => {
      const full = path.resolve(directory, relative);
      if (!full.startsWith(directory + path.sep) || !existsSync(full)) return false;
      return lstatSync(full).isFile();
    }).sort();
  const archive = path.join(destination, `${name}-source.tar.gz`);
  const tar = spawnSync('/usr/bin/tar', ['-czf', archive, '--null', '-T', '-'], {
    cwd: directory, input: Buffer.from(files.join('\0') + '\0'), maxBuffer: 1024 * 1024,
  });
  if (tar.status !== 0) throw new Error(`Archive failed: ${tar.stderr.toString()}`);
  const inventory = files.map(relative => {
    const full = path.join(directory, relative);
    return { path: relative, sha256: lstatSync(full).isFile() ? createHash('sha256').update(readFileSync(full)).digest('hex') : 'symlink' };
  });
  writeFileSync(path.join(destination, `${name}-files.json`), JSON.stringify(inventory, null, 2) + '\n');
  manifest.repositories[name] = {
    source: directory, baseCommit: git(['rev-parse', 'HEAD']).toString().trim(), files: files.length,
    archive: path.basename(archive), sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  };
}
writeFileSync(path.join(destination, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
