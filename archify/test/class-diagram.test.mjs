import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const cli = path.join(skillRoot, 'bin/archify.mjs');
const fixturePath = path.join(skillRoot, 'examples/booking-domain.class-diagram.json');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('class diagram validates and renders UML types, members, and relationship markers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-class-diagram-'));
  const output = path.join(tmp, 'booking.html');
  const validation = run(['validate', 'class-diagram', fixturePath, '--quality', 'showcase', '--json']);
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  const receipt = JSON.parse(validation.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.composition.summary.errors, 0);

  const rendered = run(['render', 'class-diagram', fixturePath, output, '--quality', 'showcase']);
  assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
  const html = fs.readFileSync(output, 'utf8');
  assert.match(html, /<title>Booking domain classes Diagram<\/title>/);
  assert.match(html, /«interface»/);
  assert.match(html, /\+ create\(/);
  assert.match(html, /id="uml-inheritance"/);
  assert.match(html, /id="uml-realization"/);
  assert.match(html, /id="uml-aggregation"/);
  assert.match(html, /id="uml-composition"/);
  assert.match(html, /data-edge-kind="realization"/);
  assert.match(html, /data-edge-kind="composition"/);
});

test('class diagram rejects unknown relationship targets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-class-diagram-invalid-'));
  const input = path.join(tmp, 'invalid.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  fixture.relationships[0].to = 'missingType';
  fs.writeFileSync(input, `${JSON.stringify(fixture)}\n`);
  const result = run(['validate', 'class-diagram', input, '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /unknown type.*missingType/i);
});

test('class diagram rejects cyclic inheritance', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-class-diagram-cycle-'));
  const input = path.join(tmp, 'cycle.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  fixture.relationships = [
    { from: 'bookingController', to: 'bookingServiceImpl', kind: 'inheritance' },
    { from: 'bookingServiceImpl', to: 'bookingController', kind: 'inheritance' },
  ];
  fs.writeFileSync(input, `${JSON.stringify(fixture)}\n`);
  const result = run(['validate', 'class-diagram', input, '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /cycle/i);
});

test('class diagram rejects overlapping type compartments', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-class-diagram-overlap-'));
  const input = path.join(tmp, 'overlap.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  fixture.types[1].pos = fixture.types[0].pos;
  fs.writeFileSync(input, `${JSON.stringify(fixture)}\n`);
  const result = run(['validate', 'class-diagram', input, '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /overlap|clearance/i);
});

test('class diagram automatically routes a relationship around an unrelated type', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-class-diagram-routing-'));
  const input = path.join(tmp, 'routing.json');
  const output = path.join(tmp, 'routing.html');
  const fixture = {
    schema_version: 1,
    diagram_type: 'class-diagram',
    meta: { title: 'Obstacle routing', quality_profile: 'standard' },
    packages: [],
    types: [
      { id: 'source', kind: 'class', name: 'Source', pos: [40, 100], size: [220, 84] },
      { id: 'blocker', kind: 'class', name: 'Blocker', pos: [360, 100], size: [220, 84] },
      { id: 'target', kind: 'class', name: 'Target', pos: [680, 100], size: [220, 84] },
    ],
    relationships: [{ id: 'source-target', from: 'source', to: 'target', kind: 'dependency', label: 'calls' }],
  };
  fs.writeFileSync(input, `${JSON.stringify(fixture)}\n`);
  const result = run(['render', 'class-diagram', input, output, '--quality', 'standard']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(output, 'utf8');
  const points = html.match(/data-edge-id="source-target"[^>]*data-composition-points="([^"]+)"/)?.[1];
  assert.ok(points, 'expected routed relationship points');
  assert.ok(points.split(';').length >= 4, points);
  assert.ok(points.split(';').some((point) => {
    const y = Number(point.split(',')[1]);
    return y < 94 || y > 190;
  }), points);
});
