#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeJavaProject } from './source-model.mjs';
import { projectControllerDiagrams } from './project-controller-diagrams.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '../..');

function fail(message) {
  throw new Error(message);
}

function parsePositive(value, option, fallback, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) fail(`${option} must be an integer from 1 to ${maximum}.`);
  return number;
}

function parseArgs(argv) {
  const options = { excludes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') { options.json = true; continue; }
    const [name, inline] = argument.split('=', 2);
    const supported = new Set(['--repo-root', '--output', '--controller', '--package', '--exclude', '--relation-depth', '--max-types', '--scenarios-per-diagram', '--locale']);
    if (!supported.has(name)) fail(`Unknown extract endpoints option "${argument}".`);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) fail(`${name} requires a value.`);
    if (name === '--exclude') options.excludes.push(value.replaceAll('\\', '/'));
    else options[{
      '--repo-root': 'repoRoot', '--output': 'output', '--controller': 'controller', '--package': 'packageName',
      '--relation-depth': 'relationDepth', '--max-types': 'maxTypes', '--scenarios-per-diagram': 'scenariosPerDiagram', '--locale': 'locale',
    }[name]] = value;
  }
  if (!options.repoRoot || !options.output) fail('extract endpoints requires --repo-root and --output.');
  options.relationDepth = parsePositive(options.relationDepth, '--relation-depth', 2, 5);
  options.maxTypes = parsePositive(options.maxTypes, '--max-types', 8, 40);
  options.scenariosPerDiagram = parsePositive(options.scenariosPerDiagram, '--scenarios-per-diagram', 3, 5);
  options.locale ||= 'en';
  if (!['en', 'ru'].includes(options.locale)) fail('--locale must be en or ru.');
  return options;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function indexHtml(entries, repoRoot, warnings, locale) {
  const copy = locale === 'ru'
    ? { title: 'Endpoint-диаграммы', open: 'Открыть диаграмму', diagnostics: 'Диагностика', diagrams: 'диаграмм' }
    : { title: 'Endpoint diagrams', open: 'Open diagram', diagnostics: 'Diagnostics', diagrams: 'diagrams' };
  const cards = entries.map((entry) => `
      <article>
        <div class="eyebrow">${escapeHtml(entry.controller.fqn)}</div>
        <h2>${escapeHtml(entry.title)}</h2>
        <ul>${entry.endpoints.map((endpoint) => `<li><code>${escapeHtml(endpoint.httpMethod)} ${escapeHtml(endpoint.path)}</code><span>${escapeHtml(endpoint.javaMethod)}()</span></li>`).join('')}</ul>
        <a href="diagrams/${encodeURIComponent(entry.artifact)}">${copy.open} →</a>
      </article>`).join('');
  const warningBlock = warnings.length ? `<section class="warnings"><h2>${copy.diagnostics}</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></section>` : '';
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${copy.title}</title><style>
:root{color-scheme:dark;background:#07111f;color:#e6f1ff;font-family:Inter,system-ui,sans-serif}body{max-width:1180px;margin:0 auto;padding:42px 24px 72px}header{margin-bottom:28px}.eyebrow{color:#67e8f9;font:600 11px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;overflow-wrap:anywhere}h1{font-size:34px;margin:8px 0}header p{color:#9fb0c4}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}article,.warnings{border:1px solid #28415d;border-radius:14px;background:#0b1a2c;padding:20px}h2{font-size:19px;margin:8px 0 14px}ul{padding:0;list-style:none;margin:0 0 18px}li{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid #1d334b;color:#9fb0c4}code{color:#d8f7ff}a{color:#67e8f9;text-decoration:none;font-weight:650}.warnings{margin-top:22px}.warnings li{display:list-item;margin-left:18px;list-style:disc}
</style></head><body><header><div class="eyebrow">Archify · Java/Spring</div><h1>${copy.title}</h1><p>${escapeHtml(repoRoot)} · ${entries.length} ${copy.diagrams}</p></header><main>${cards}</main>${warningBlock}</body></html>`;
}

function runChecked(command, args, env = {}) {
  const result = spawnSync(process.execPath, [command, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) fail((result.stderr || result.stdout || `Command failed with ${result.status}`).trim());
  return result.stdout;
}

function ensureSafeTarget(repoRoot, output) {
  const root = path.resolve(repoRoot);
  const target = path.resolve(output);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`Repository root does not exist or is not a directory: ${root}`);
  if (target === root) fail('Output directory must not be the repository root.');
  if (fs.existsSync(target)) fail(`Output directory already exists: ${target}. Choose a new directory.`);
  return { root, target };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { root, target } = ensureSafeTarget(options.repoRoot, options.output);
  const model = analyzeJavaProject(root, options);
  const projection = projectControllerDiagrams(model, options);
  if (!projection.diagrams.length) fail(projection.warnings.at(-1) || 'No endpoint diagrams could be produced.');
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.archify-endpoints-'));
  const sourcesDir = path.join(staging, 'sources');
  const diagramsDir = path.join(staging, 'diagrams');
  fs.mkdirSync(sourcesDir);
  fs.mkdirSync(diagramsDir);
  const entries = [];
  try {
    for (const projected of projection.diagrams) {
      const sourceName = `${projected.id}.class-diagram.json`;
      const artifactName = `${projected.id}.html`;
      const sourcePath = path.join(sourcesDir, sourceName);
      const artifactPath = path.join(diagramsDir, artifactName);
      fs.writeFileSync(sourcePath, `${JSON.stringify(projected.diagram, null, 2)}\n`);
      runChecked(
        path.join(skillRoot, 'renderers/class-diagram/render-class-diagram.mjs'),
        [sourcePath, artifactPath],
        { ARCHIFY_QUALITY_PROFILE: 'standard', ARCHIFY_DIAGNOSTIC_FORMAT: 'json' },
      );
      const check = JSON.parse(runChecked(path.join(skillRoot, 'scripts/check-render-output.mjs'), [artifactPath]));
      entries.push({
        id: projected.id,
        controller: { name: projected.controller.name, fqn: projected.controller.fqn, path: projected.controller.file, line: projected.controller.line },
        title: projected.diagram.meta.title,
        endpoints: projected.endpoints,
        source: `sources/${sourceName}`,
        artifact: artifactName,
        evidence: projected.evidence,
        validation: {
          checksPassed: check.checks.filter((item) => item.ok).length,
          checkCount: check.checks.length,
          composition: check.composition,
        },
      });
    }
    const manifest = {
      schemaVersion: 1,
      kind: 'archify-endpoint-diagrams',
      repositoryRoot: root,
      generatedFrom: { javaFiles: model.files.length, discoveredTypes: model.types.length, controllers: model.controllers.length },
      options: {
        relationDepth: options.relationDepth,
        maxTypes: options.maxTypes,
        scenariosPerDiagram: options.scenariosPerDiagram,
        locale: options.locale,
        ...(options.controller ? { controller: options.controller } : {}),
        ...(options.packageName ? { package: options.packageName } : {}),
      },
      warnings: projection.warnings,
      diagrams: entries,
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(staging, 'index.html'), indexHtml(entries, root, projection.warnings, options.locale));
    fs.renameSync(staging, target);
    const receipt = { ok: true, command: 'extract endpoints', output: target, ...manifest.generatedFrom, diagrams: entries.length, warnings: projection.warnings };
    if (options.json) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    else {
      console.log(`Created ${entries.length} endpoint diagram(s) from ${model.controllers.length} controller(s).`);
      console.log(path.join(target, 'index.html'));
      for (const warning of projection.warnings) console.warn(`warning: ${warning}`);
    }
  } catch (error) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

try {
  main();
} catch (error) {
  console.error(`Endpoint extraction failed: ${error.message}`);
  process.exitCode = 1;
}
