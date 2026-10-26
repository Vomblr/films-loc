import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export function deploymentInfo(root, dataDir) {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const files = ['package.json', ...readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.mjs')).map(entry => entry.name)];
  function publicFiles(directory) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) publicFiles(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  publicFiles('public');
  const hash = createHash('sha256');
  for (const name of files.sort()) hash.update(name.replaceAll('\\', '/')).update('\0').update(readFileSync(path.join(root, name))).update('\0');
  const fingerprint = hash.digest('hex'), filename = path.join(dataDir, 'deployment.json');
  let saved;
  try { saved = JSON.parse(readFileSync(filename, 'utf8')); } catch { /* First deployment or damaged metadata. */ }
  if (saved?.version === version && saved.fingerprint === fingerprint && Number.isFinite(Date.parse(saved.deployedAt)))
    return { version, deployedAt: saved.deployedAt };
  const deployedAt = new Date().toISOString(), temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version, deployedAt, fingerprint }, null, 2) + '\n', 'utf8');
  renameSync(temporary, filename);
  return { version, deployedAt };
}
