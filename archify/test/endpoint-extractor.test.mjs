import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeJavaProject } from '../extractors/java/source-model.mjs';
import { projectControllerDiagrams } from '../extractors/java/project-controller-diagrams.mjs';
import { enrichEndpointDiagramsWithCodex } from '../extractors/java/enrich-endpoint-ai.mjs';

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
  const createEndpoint = model.controllers[0].endpoints.find((endpoint) => endpoint.javaMethod === 'create');
  assert.deepEqual(createEndpoint.parameterTypeIds, [model.types.find((type) => type.name === 'CreateMemberRequest').id]);
  assert.deepEqual(createEndpoint.returnTypeIds, [model.types.find((type) => type.name === 'MemberResponse').id]);
  const implementation = model.types.find((type) => type.name === 'DefaultMemberService');
  assert.ok(implementation.implementsIds.includes(model.types.find((type) => type.name === 'MemberService').id));
  assert.ok(implementation.dependencies.some((dependency) => dependency.target === model.types.find((type) => type.name === 'MemberRepository').id));
});

test('extract endpoints writes controller-grouped diagrams, evidence, and an index', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-endpoint-extract-'));
  const output = path.join(tmp, 'result');
  const result = spawnSync(process.execPath, [
    cli, 'extract', 'endpoints', '--repo-root', fixture, '--output', output,
    '--mode', 'reference', '--scenarios-per-diagram', '3', '--locale', 'ru', '--json',
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
  const controllerLanes = firstSource.types.filter((type) => type.name === 'MemberController');
  assert.equal(controllerLanes.length, 3);
  const implementationLanes = firstSource.types.filter((type) => type.name === 'DefaultMemberService');
  assert.equal(implementationLanes.length, 3);
  assert.deepEqual(
    implementationLanes.flatMap((type) => type.methods.map((method) => method.name)).sort(),
    ['create', 'delete', 'findById'],
  );
  const focusedIds = firstSource.meta.views.map((view) => new Set(view.focus));
  assert.ok(focusedIds.every((focus, index) => [...focus].every((id) => id.endsWith(`__s1_${index + 1}`))));
  assert.equal(new Set(focusedIds.flatMap((focus) => [...focus])).size, focusedIds.reduce((sum, focus) => sum + focus.size, 0));
  assert.ok(firstSource.relationships.every((relationship) => {
    const fromLane = relationship.from.match(/__s1_(\d+)$/)?.[1];
    const toLane = relationship.to.match(/__s1_(\d+)$/)?.[1];
    return fromLane && fromLane === toLane;
  }));
  assert.ok(manifest.diagrams[0].evidence.some((item) => item.sourceId && item.id !== item.sourceId));
  const index = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.ok(index.includes('MemberController'));
  assert.match(index, /lang="ru"/);
  assert.match(index, /Открыть диаграмму/);
});

test('extract endpoints defaults to one compact onboarding scenario per diagram', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-endpoint-onboarding-'));
  const output = path.join(tmp, 'result');
  const result = spawnSync(process.execPath, [
    cli, 'extract', 'endpoints', '--repo-root', fixture, '--output', output, '--locale', 'ru', '--json',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.diagrams, 4);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.options.mode, 'onboarding');
  assert.equal(manifest.options.scenariosPerDiagram, 1);
  assert.equal(manifest.options.maxTypes, 7);
  assert.ok(manifest.diagrams.every((entry) => entry.endpoints.length === 1));
  const source = JSON.parse(fs.readFileSync(path.join(output, manifest.diagrams[0].source), 'utf8'));
  assert.ok(source.types.some((type) => type.stereotype === '1 · вход'));
  assert.ok(source.types.some((type) => type.stereotype === '2 · контроллер'));
  const index = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.match(index, /Карта эндпоинтов для онбординга/);
  assert.match(index, /Изучить сценарий/);
  assert.match(index, /class="controller-group"/);
  assert.match(index, /1 диаграмма|4 диаграммы/);
  assert.doesNotMatch(index, /1 классов|1 связей/);
  assert.equal(source.cards.length, 1);
  assert.match(source.cards[0].title, /Точка входа/);
  assert.doesNotMatch(JSON.stringify(source.cards), /Как читать/);
});

test('AI enrichment replaces generic guidance with evidence-grounded implementation notes', () => {
  const model = analyzeJavaProject(fixture);
  const projection = projectControllerDiagrams(model, {
    mode: 'onboarding', locale: 'ru', relationDepth: 2, maxTypes: 7, scenariosPerDiagram: 1, excludes: [],
  });
  let receivedPrompt = '';
  const result = enrichEndpointDiagramsWithCodex(projection, fixture, {
    locale: 'ru',
    codexRunner({ prompt, schema }) {
      receivedPrompt = prompt;
      return {
        analyses: schema.properties.analyses.items.properties.analysisId.enum.map((analysisId) => {
          const diagram = projection.diagrams.find((item) => item.id === analysisId);
          const evidence = [...new Map(diagram.evidence.map((item) => [item.path, { path: item.path, line: item.line }])).values()].slice(0, 2);
          return {
            analysisId,
            summary: 'Эндпоинт выполняет подтверждённый исходным кодом пользовательский сценарий.',
            implementation: ['Контроллер принимает запрос.', 'Сервис выполняет основную операцию.'],
            features: ['Поведение описано только по найденным вызовам.'],
            evidence,
          };
        }),
      };
    },
  });
  assert.equal(result.analyses, projection.diagrams.length);
  assert.match(receivedPrompt, /in Russian/);
  assert.ok(projection.diagrams.every((item) => item.diagram.cards.length === 4));
  assert.ok(projection.diagrams.every((item) => item.diagram.cards[0].title === 'Что делает сценарий'));
  assert.ok(projection.diagrams.every((item) => item.aiAnalysis.evidence.length >= 1));
});

test('extract endpoints limits AI explanations to one-scenario onboarding diagrams', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-endpoint-ai-options-'));
  const reference = spawnSync(process.execPath, [
    cli, 'extract', 'endpoints', '--repo-root', fixture, '--output', path.join(tmp, 'reference'), '--mode', 'reference', '--ai',
  ], { encoding: 'utf8' });
  assert.notEqual(reference.status, 0);
  assert.match(reference.stderr, /--ai requires --mode onboarding/);

  const modelWithoutAi = spawnSync(process.execPath, [
    cli, 'extract', 'endpoints', '--repo-root', fixture, '--output', path.join(tmp, 'model'), '--ai-model', 'gpt-example',
  ], { encoding: 'utf8' });
  assert.notEqual(modelWithoutAi.status, 0);
  assert.match(modelWithoutAi.stderr, /--ai-model requires --ai/);
});

test('extract endpoints rejects unsupported index locales', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-endpoint-locale-'));
  const result = spawnSync(process.execPath, [
    cli, 'extract', 'endpoints', '--repo-root', fixture, '--output', path.join(tmp, 'result'), '--locale', 'de',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--locale must be en or ru/);
});

test('extract endpoints rejects unsupported modes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-endpoint-mode-'));
  const result = spawnSync(process.execPath, [
    cli, 'extract', 'endpoints', '--repo-root', fixture, '--output', path.join(tmp, 'result'), '--mode', 'dense',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--mode must be onboarding or reference/);
});

test('extract endpoints refuses to overwrite an existing output directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-endpoint-existing-'));
  const result = spawnSync(process.execPath, [
    cli, 'extract', 'endpoints', '--repo-root', fixture, '--output', tmp,
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/i);
});
