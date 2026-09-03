import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeJavaProject } from '../extractors/java/source-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures/java-endpoints');
const cli = path.join(skillRoot, 'bin/archify.mjs');

test('Java source model discovers Spring endpoints and proven type dependencies', () => {
  const model = analyzeJavaProject(fixture);
  assert.equal(model.controllers.length, 1);
  assert.equal(model.controllers[0].name, 'MemberController');
  assert.deepEqual(
    model.controllers[0].endpoints.map((endpoint) => `${endpoint.httpMethod} ${endpoint.path}`).sort(),
    ['DELETE /members/{id}', 'GET /members/{id}', 'POST /members', 'PUT /members/{id}'],
  );
  const controllerDependencies = model.controllers[0].dependencies.map((dependency) => dependency.target);
  assert.ok(controllerDependencies.includes(model.types.find((type) => type.name === 'MemberService').id));
  const implementation = model.types.find((type) => type.name === 'DefaultMemberService');
  assert.ok(implementation.implementsIds.includes(model.types.find((type) => type.name === 'MemberService').id));
  assert.ok(implementation.dependencies.some((dependency) => dependency.target === model.types.find((type) => type.name === 'MemberRepository').id));
});

test('extract endpoints writes controller-grouped diagrams, evidence, and an index', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-endpoint-extract-'));
  const output = path.join(tmp, 'result');
  const result = spawnSync(process.execPath, [
    cli, 'extract', 'endpoints', '--repo-root', fixture, '--output', output,
    '--scenarios-per-diagram', '3', '--locale', 'ru', '--json',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.controllers, 1);
  assert.equal(receipt.diagrams, 2);
  assert.ok(fs.existsSync(path.join(output, 'index.html')));

  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.diagrams.length, 2);
  assert.deepEqual(manifest.diagrams.map((entry) => entry.endpoints.length), [3, 1]);
  assert.ok(manifest.diagrams.every((entry) => entry.validation.checksPassed === entry.validation.checkCount));
  assert.ok(manifest.diagrams.every((entry) => entry.evidence.some((item) => item.fqn.endsWith('.MemberService'))));

  const firstSource = JSON.parse(fs.readFileSync(path.join(output, manifest.diagrams[0].source), 'utf8'));
  assert.equal(firstSource.meta.views.length, 3);
  assert.ok(firstSource.types.some((type) => type.name === 'MemberController'));
  assert.ok(firstSource.types.some((type) => type.name === 'MemberRepository'));
  const implementation = firstSource.types.find((type) => type.name === 'DefaultMemberService');
  assert.deepEqual(implementation.methods.map((method) => method.name).sort(), ['create', 'delete', 'findById']);
  const index = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.ok(index.includes('MemberController'));
  assert.match(index, /lang="ru"/);
  assert.match(index, /Открыть диаграмму/);
});

test('extract endpoints rejects unsupported index locales', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-endpoint-locale-'));
  const result = spawnSync(process.execPath, [
    cli, 'extract', 'endpoints', '--repo-root', fixture, '--output', path.join(tmp, 'result'), '--locale', 'de',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--locale must be en or ru/);
});

test('extract endpoints refuses to overwrite an existing output directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-endpoint-existing-'));
  const result = spawnSync(process.execPath, [
    cli, 'extract', 'endpoints', '--repo-root', fixture, '--output', tmp,
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/i);
});
