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
