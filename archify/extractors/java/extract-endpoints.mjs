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
    const supported = new Set(['--repo-root', '--output', '--controller', '--package', '--exclude', '--relation-depth', '--max-types', '--scenarios-per-diagram', '--locale', '--mode']);
    if (!supported.has(name)) fail(`Unknown extract endpoints option "${argument}".`);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) fail(`${name} requires a value.`);
    if (name === '--exclude') options.excludes.push(value.replaceAll('\\', '/'));
    else options[{
      '--repo-root': 'repoRoot', '--output': 'output', '--controller': 'controller', '--package': 'packageName',
      '--relation-depth': 'relationDepth', '--max-types': 'maxTypes', '--scenarios-per-diagram': 'scenariosPerDiagram', '--locale': 'locale', '--mode': 'mode',
    }[name]] = value;
  }
  if (!options.repoRoot || !options.output) fail('extract endpoints requires --repo-root and --output.');
  options.mode ||= 'onboarding';
  if (!['onboarding', 'reference'].includes(options.mode)) fail('--mode must be onboarding or reference.');
  options.relationDepth = parsePositive(options.relationDepth, '--relation-depth', 2, 5);
  options.maxTypes = parsePositive(options.maxTypes, '--max-types', options.mode === 'onboarding' ? 7 : 8, 40);
  options.scenariosPerDiagram = parsePositive(options.scenariosPerDiagram, '--scenarios-per-diagram', options.mode === 'onboarding' ? 1 : 3, 5);
  options.locale ||= 'en';
  if (!['en', 'ru'].includes(options.locale)) fail('--locale must be en or ru.');
  return options;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function countLabel(value, locale, forms) {
  if (locale !== 'ru') return `${value} ${value === 1 ? forms[0] : forms[1]}`;
  const mod100 = value % 100;
  const mod10 = value % 10;
  const form = mod100 >= 11 && mod100 <= 14 ? forms[2] : mod10 === 1 ? forms[0] : mod10 >= 2 && mod10 <= 4 ? forms[1] : forms[2];
  return `${value} ${form}`;
}

function indexHtml(entries, repoRoot, warnings, locale, mode) {
  const copy = locale === 'ru'
    ? {
      title: mode === 'onboarding' ? 'Карта эндпоинтов для онбординга' : 'Endpoint-диаграммы',
      intro: mode === 'onboarding' ? 'Выберите контроллер и изучайте сценарии по одному: от входного DTO до данных и ответа.' : 'Диаграммы сгруппированы по контроллерам.',
      open: mode === 'onboarding' ? 'Изучить сценарий' : 'Открыть диаграмму', diagnostics: 'Диагностика', source: 'Исходный файл', controller: 'Контроллер', mode: mode === 'onboarding' ? 'онбординг' : 'справочник',
    }
    : {
      title: mode === 'onboarding' ? 'Endpoint onboarding map' : 'Endpoint diagrams',
      intro: mode === 'onboarding' ? 'Choose a controller and study one scenario at a time, from request DTO to data and response.' : 'Diagrams are grouped by controller.',
      open: mode === 'onboarding' ? 'Study scenario' : 'Open diagram', diagnostics: 'Diagnostics', source: 'Source file', controller: 'Controller', mode,
    };
  const groups = [];
  for (const entry of entries) {
    let group = groups.find((item) => item.fqn === entry.controller.fqn);
    if (!group) {
      group = { ...entry.controller, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  const cards = groups.map((group) => `
    <section class="controller-group">
      <div class="eyebrow">${copy.controller}</div>
      <h2>${escapeHtml(group.name)}</h2>
      <p class="source">${copy.source}: <code>${escapeHtml(group.path)}:${group.line}</code></p>
      <div class="scenario-grid">${group.entries.map((entry) => `
        <article>
          ${entry.endpoints.map((endpoint) => `<div class="route"><span>${escapeHtml(endpoint.httpMethod)}</span><code>${escapeHtml(endpoint.path)}</code></div><strong>${escapeHtml(endpoint.javaMethod)}()</strong>`).join('')}
          <p class="facts">${countLabel(entry.typeCount, locale, locale === 'ru' ? ['класс', 'класса', 'классов'] : ['type', 'types'])} · ${countLabel(entry.relationshipCount, locale, locale === 'ru' ? ['связь', 'связи', 'связей'] : ['relationship', 'relationships'])}</p>
          <a href="diagrams/${encodeURIComponent(entry.artifact)}">${copy.open} →</a>
        </article>`).join('')}</div>
    </section>`).join('');
  const warningBlock = warnings.length ? `<section class="warnings"><h2>${copy.diagnostics}</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></section>` : '';
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${copy.title}</title><style>
:root{color-scheme:dark;background:#07111f;color:#e6f1ff;font-family:Inter,system-ui,sans-serif}body{max-width:1180px;margin:0 auto;padding:42px 24px 72px}header{margin-bottom:32px}.eyebrow{color:#67e8f9;font:600 11px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;overflow-wrap:anywhere}h1{font-size:34px;margin:8px 0}header p,.source,.facts{color:#9fb0c4}.path{font:12px ui-monospace,monospace}.controller-group{margin:0 0 34px}.controller-group>h2{font-size:25px;margin:6px 0}.source{font-size:12px;margin:0 0 14px}.scenario-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}article,.warnings{border:1px solid #28415d;border-radius:14px;background:#0b1a2c;padding:18px}.route{display:flex;align-items:center;gap:9px;margin-bottom:10px}.route span{color:#07111f;background:#67e8f9;border-radius:5px;padding:4px 7px;font:bold 10px ui-monospace,monospace}.route code{overflow-wrap:anywhere}article strong{font:650 15px ui-monospace,monospace}.facts{font-size:12px;margin:11px 0 16px}code{color:#d8f7ff}a{color:#67e8f9;text-decoration:none;font-weight:650}.warnings{margin-top:22px}.warnings li{margin:8px 0;color:#9fb0c4}
</style></head><body><header><div class="eyebrow">Archify · Java/Spring · ${escapeHtml(copy.mode)}</div><h1>${copy.title}</h1><p>${escapeHtml(copy.intro)}</p><p class="path">${escapeHtml(repoRoot)} · ${countLabel(entries.length, locale, locale === 'ru' ? ['диаграмма', 'диаграммы', 'диаграмм'] : ['diagram', 'diagrams'])}</p></header><main>${cards}</main>${warningBlock}</body></html>`;
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
        typeCount: projected.diagram.types.length,
        relationshipCount: projected.diagram.relationships.length,
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
        mode: options.mode,
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
    fs.writeFileSync(path.join(staging, 'index.html'), indexHtml(entries, root, projection.warnings, options.locale, options.mode));
    fs.renameSync(staging, target);
    const receipt = { ok: true, command: 'extract endpoints', mode: options.mode, output: target, ...manifest.generatedFrom, diagrams: entries.length, warnings: projection.warnings };
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
