import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const JAVA_KEYWORDS = new Set([
  'boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void',
  'String', 'Object', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character',
  'List', 'Set', 'Map', 'Collection', 'Iterable', 'Optional', 'Stream', 'Page',
  'ResponseEntity', 'HttpEntity', 'CompletableFuture', 'Mono', 'Flux',
]);

function stripComments(source) {
  let result = '';
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'line') {
      if (char === '\n') { state = 'code'; result += '\n'; } else result += ' ';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { result += '  '; index += 1; state = 'code'; }
      else result += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'string' || state === 'char') {
      result += char;
      if (char === '\\') { result += next || ''; index += 1; continue; }
      if ((state === 'string' && char === '"') || (state === 'char' && char === "'")) state = 'code';
      continue;
    }
    if (char === '/' && next === '/') { result += '  '; index += 1; state = 'line'; continue; }
    if (char === '/' && next === '*') { result += '  '; index += 1; state = 'block'; continue; }
    if (char === '"') state = 'string';
    if (char === "'") state = 'char';
    result += char;
  }
  return result;
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function methodCalls(body) {
  const calls = [];
  for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!calls.some((item) => item.receiver === match[1] && item.method === match[2])) {
      calls.push({ receiver: match[1], method: match[2] });
    }
  }
  return calls;
}

function bodyAfterSignature(source, signature) {
  const signatureEnd = signature.index + signature[0].length;
  if (!signature[0].trimEnd().endsWith('{')) return { body: '', end: signatureEnd };
  const open = source.indexOf('{', signature.index + signature[0].length - 1);
  if (open < 0) return { body: '', end: signatureEnd };
  let depth = 1;
  let state = 'code';
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index];
    if (state !== 'code') {
      if (char === '\\') { index += 1; continue; }
      if ((state === 'string' && char === '"') || (state === 'char' && char === "'")) state = 'code';
      continue;
    }
    if (char === '"') { state = 'string'; continue; }
    if (char === "'") { state = 'char'; continue; }
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return { body: source.slice(open + 1, index), end: index + 1 };
  }
  return { body: source.slice(open + 1), end: source.length };
}

function splitTopLevel(value) {
  const parts = [];
  let current = '';
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  for (const char of value) {
    if (char === '<') angle += 1;
    if (char === '>') angle = Math.max(0, angle - 1);
    if (char === '(') paren += 1;
    if (char === ')') paren = Math.max(0, paren - 1);
    if (char === '[') bracket += 1;
    if (char === ']') bracket = Math.max(0, bracket - 1);
    if (char === ',' && angle === 0 && paren === 0 && bracket === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function annotationsFrom(block = '') {
  const annotations = [];
  const regex = /@([\w.]+)(?:\s*\(([^)]*)\))?/g;
  for (const match of block.matchAll(regex)) {
    annotations.push({ name: match[1].split('.').at(-1), args: match[2] || '' });
  }
  return annotations;
}

function annotation(annotations, name) {
  return annotations.find((item) => item.name === name);
}

function annotationPath(item) {
  if (!item) return '';
  const named = item.args.match(/(?:value|path)\s*=\s*["']([^"']+)["']/);
  const first = item.args.match(/["']([^"']+)["']/);
  return (named?.[1] || first?.[1] || '').trim();
}

function normalizeRoute(...parts) {
  const joined = parts.filter(Boolean).join('/').replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  if (!joined) return '/';
  return `/${joined.replace(/^\/+|\/+$/g, '')}`;
}

function parseParameters(raw, line) {
  return splitTopLevel(raw).map((parameter) => {
    const cleaned = parameter
      .replace(/@[\w.]+(?:\s*\([^)]*\))?/g, ' ')
      .replace(/\bfinal\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const match = cleaned.match(/^(.+?)\s+([A-Za-z_$][\w$]*)$/);
    if (!match) return null;
    return { name: match[2], type: match[1].trim(), line };
  }).filter(Boolean);
}

function visibility(text = '') {
  if (/\bprivate\b/.test(text)) return 'private';
  if (/\bprotected\b/.test(text)) return 'protected';
  if (/\bpublic\b/.test(text)) return 'public';
  return 'package';
}

function stereotypeFor(name, annotations) {
  const names = new Set(annotations.map((item) => item.name));
  if (names.has('RestController') || names.has('Controller')) return 'controller';
  if (names.has('Service')) return 'service';
  if (names.has('Repository') || name.endsWith('Repository')) return 'repository';
  if (names.has('Mapper') || name.endsWith('Mapper')) return 'mapper';
  if (names.has('Entity') || names.has('Document')) return 'entity';
  if (name.endsWith('Request') || name.endsWith('Response') || name.endsWith('Dto') || name.endsWith('DTO')) return 'dto';
  return '';
}

function methodHttp(annotationItem) {
  const direct = {
    GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT',
    PatchMapping: 'PATCH', DeleteMapping: 'DELETE',
  }[annotationItem?.name];
  if (direct) return direct;
  if (annotationItem?.name !== 'RequestMapping') return null;
  return annotationItem.args.match(/RequestMethod\.([A-Z]+)/)?.[1] || 'ANY';
}

function unwrapType(type) {
  let value = String(type || '').replace(/[?]/g, '').replace(/\bextends\b|\bsuper\b/g, ' ').trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const wrapper = value.match(/^(?:ResponseEntity|HttpEntity|Optional|Mono|Flux|CompletableFuture|Page|List|Set|Collection|Iterable)<(.+)>$/);
    if (!wrapper) break;
    value = wrapper[1].trim();
  }
  return value.replace(/\[\]$/, '').trim();
}

function typeTokens(type) {
  return [...new Set(String(type || '').match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) || [])]
    .filter((token) => !JAVA_KEYWORDS.has(token) && !/^[a-z]$/.test(token));
}

function stableId(fqn) {
  const name = fqn.split('.').at(-1).replace(/[^a-zA-Z0-9_-]/g, '_');
  const prefix = /^[a-zA-Z]/.test(name) ? name : `T_${name}`;
  const digest = crypto.createHash('sha1').update(fqn).digest('hex').slice(0, 7);
  return `${prefix}_${digest}`;
}

function discoverJavaFiles(root, excludes = []) {
  const files = [];
  const ignored = new Set(['.git', '.idea', '.gradle', 'build', 'target', 'node_modules', 'out']);
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (excludes.some((pattern) => relative.includes(pattern))) continue;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.java')) files.push(absolute);
    }
  }
  walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function parseJavaFile(file, root) {
  const original = fs.readFileSync(file, 'utf8');
  const source = stripComments(original);
  const packageName = source.match(/\bpackage\s+([\w.]+)\s*;/)?.[1] || '';
  const imports = new Map();
  for (const match of source.matchAll(/\bimport\s+(?:static\s+)?([\w.]+)\s*;/g)) {
    if (!match[1].endsWith('.*')) imports.set(match[1].split('.').at(-1), match[1]);
  }
  const declaration = /((?:\s*@[\w.]+(?:\s*\([^)]*\))?\s*)*)(?:(public|protected|private|abstract|final|sealed|non-sealed|static)\s+)*(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)([^\{;]*)\{/m.exec(source);
  if (!declaration) return null;
  const declarationAnnotations = annotationsFrom(declaration[1]);
  const javaKind = declaration[3];
  const name = declaration[4];
  const tail = declaration[5] || '';
  const fqn = packageName ? `${packageName}.${name}` : name;
  const fields = [];
  const fieldRegex = /^\s*((?:public|protected|private)\s+(?:(?:static|final|transient|volatile)\s+)*)((?:[\w$.]+)(?:\s*<[^;=]+>)?(?:\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;/gm;
  for (const match of source.matchAll(fieldRegex)) {
    fields.push({
      visibility: visibility(match[1]), name: match[3], type: match[2].replace(/\s+/g, ' ').trim(),
      static: /\bstatic\b/.test(match[1]), final: /\bfinal\b/.test(match[1]), line: lineAt(source, match.index),
    });
  }
  const methods = [];
  // Keep the return type on one physical line. This prevents declarations inside
  // method bodies from being joined to the next call and mistaken for a method.
  // Parameters may remain multiline, which is common in Spring controllers.
  const methodRegex = /^[ \t]*((?:(?:public|protected|private|static|final|abstract|synchronized|default)[ \t]+)*)((?:[\w$.?]+)(?:[ \t]*<[^;{}()\r\n]+>)?(?:\[\])?)[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(([^{};]*?)\)[ \t]*(?:throws[ \t]+[^{;\r\n]+)?[\{;]/gm;
  let previousSignatureEnd = declaration.index + declaration[0].length;
  for (const match of source.matchAll(methodRegex)) {
    if (match.index < previousSignatureEnd) continue;
    const line = lineAt(source, match.index);
    if (match[3] === name) continue;
    const leadingSource = source.slice(previousSignatureEnd, match.index);
    const annotations = annotationsFrom(leadingSource);
    const methodBody = bodyAfterSignature(source, match);
    methods.push({
      name: match[3], returns: match[2].replace(/\s+/g, ' ').trim(),
      parameters: parseParameters(match[4], line), visibility: visibility(match[1]),
      static: /\bstatic\b/.test(match[1]), abstract: /\babstract\b/.test(match[1]) || javaKind === 'interface',
      annotations, calls: methodCalls(methodBody.body), line,
    });
    previousSignatureEnd = methodBody.end;
  }
  const constructors = [];
  const constructorRegex = new RegExp(`^[ \\t]*(?:public|protected|private)?[ \\t]*${name}[ \\t]*\\(([^)]*)\\)`, 'gm');
  for (const match of source.matchAll(constructorRegex)) {
    constructors.push(...parseParameters(match[1], lineAt(source, match.index)));
  }
  const extension = tail.match(/\bextends\s+([\w$.]+)/)?.[1] || null;
  const implementationText = tail.match(/\bimplements\s+([^\{]+)/)?.[1] || '';
  const implementations = splitTopLevel(implementationText).map((item) => item.trim()).filter(Boolean);
  if (javaKind === 'interface') {
    const parents = tail.match(/\bextends\s+(.+)/)?.[1] || '';
    implementations.push(...splitTopLevel(parents).map((item) => item.trim()).filter(Boolean));
  }
  const baseMapping = annotationPath(annotation(declarationAnnotations, 'RequestMapping'));
  const endpoints = [];
  for (const method of methods) {
    const mapping = method.annotations.find((item) => ['GetMapping', 'PostMapping', 'PutMapping', 'PatchMapping', 'DeleteMapping', 'RequestMapping'].includes(item.name));
    const httpMethod = methodHttp(mapping);
    if (!httpMethod) continue;
    endpoints.push({
      id: `${httpMethod.toLowerCase()}-${method.name}-${method.line}`,
      httpMethod,
      path: normalizeRoute(baseMapping, annotationPath(mapping)),
      javaMethod: method.name,
      parameters: method.parameters,
      returnType: method.returns,
      line: method.line,
    });
  }
  return {
    id: stableId(fqn), fqn, name, packageName, imports,
    file: path.relative(root, file).replaceAll('\\', '/'), line: lineAt(source, declaration.index),
    kind: javaKind === 'interface' ? 'interface' : javaKind === 'enum' ? 'enum' : /\babstract\b/.test(declaration[0]) ? 'abstract-class' : 'class',
    stereotype: javaKind === 'record' ? 'record' : stereotypeFor(name, declarationAnnotations),
    annotations: declarationAnnotations, fields, methods, constructors, extension, implementations, endpoints,
  };
}

function resolveReference(raw, owner, byFqn, bySimple) {
  const token = unwrapType(raw).split(/\s/).at(-1);
  if (!token || JAVA_KEYWORDS.has(token)) return null;
  if (byFqn.has(token)) return byFqn.get(token);
  const simple = token.split('.').at(-1);
  const imported = owner.imports.get(simple);
  if (imported && byFqn.has(imported)) return byFqn.get(imported);
  const samePackage = owner.packageName ? `${owner.packageName}.${simple}` : simple;
  if (byFqn.has(samePackage)) return byFqn.get(samePackage);
  const candidates = bySimple.get(simple) || [];
  return candidates.length === 1 ? candidates[0] : null;
}

export function analyzeJavaProject(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const files = discoverJavaFiles(absoluteRoot, options.excludes || []);
  const types = files.map((file) => parseJavaFile(file, absoluteRoot)).filter(Boolean);
  const byFqn = new Map(types.map((type) => [type.fqn, type]));
  const bySimple = new Map();
  for (const type of types) bySimple.set(type.name, [...(bySimple.get(type.name) || []), type]);
  const warnings = [];
  for (const type of types) {
    type.dependencies = [];
    const rawDependencies = [
      ...type.fields.flatMap((field) => typeTokens(field.type).map((name) => ({ name, reason: `field ${field.name}`, line: field.line }))),
      ...type.constructors.flatMap((parameter) => typeTokens(parameter.type).map((name) => ({ name, reason: `constructor ${parameter.name}`, line: parameter.line }))),
      ...type.methods.flatMap((method) => [method.returns, ...method.parameters.map((parameter) => parameter.type)]
        .flatMap((raw) => typeTokens(raw).map((name) => ({ name, reason: `method ${method.name}`, line: method.line })))),
    ];
    for (const dependency of rawDependencies) {
      const target = resolveReference(dependency.name, type, byFqn, bySimple);
      if (target && target.id !== type.id && !type.dependencies.some((item) => item.target === target.id)) {
        type.dependencies.push({ target: target.id, reason: dependency.reason, line: dependency.line });
      }
    }
    const fieldTargets = new Map();
    for (const field of type.fields) {
      const target = resolveReference(field.type, type, byFqn, bySimple);
      field.targetId = target?.id || null;
      if (target) fieldTargets.set(field.name, target.id);
    }
    for (const method of type.methods) {
      method.typeIds = [];
      for (const raw of [method.returns, ...method.parameters.map((parameter) => parameter.type)]) {
        for (const token of typeTokens(raw)) {
          const target = resolveReference(token, type, byFqn, bySimple);
          if (target && !method.typeIds.includes(target.id)) method.typeIds.push(target.id);
        }
      }
      method.callTargets = method.calls.map((call) => ({
        target: fieldTargets.get(call.receiver),
        method: call.method,
        receiver: call.receiver,
      })).filter((call) => call.target);
    }
    type.extendsId = type.extension ? resolveReference(type.extension, type, byFqn, bySimple)?.id || null : null;
    type.implementsIds = type.implementations.map((name) => resolveReference(name, type, byFqn, bySimple)?.id).filter(Boolean);
    for (const endpoint of type.endpoints) {
      endpoint.typeIds = [];
      endpoint.parameterTypeIds = [];
      endpoint.returnTypeIds = [];
      for (const parameter of endpoint.parameters) {
        for (const token of typeTokens(parameter.type)) {
          const target = resolveReference(token, type, byFqn, bySimple);
          if (target && !endpoint.parameterTypeIds.includes(target.id)) endpoint.parameterTypeIds.push(target.id);
        }
      }
      for (const token of typeTokens(endpoint.returnType)) {
        const target = resolveReference(token, type, byFqn, bySimple);
        if (target && !endpoint.returnTypeIds.includes(target.id)) endpoint.returnTypeIds.push(target.id);
      }
      for (const raw of [...endpoint.parameters.map((item) => item.type), endpoint.returnType]) {
        for (const token of typeTokens(raw)) {
          const target = resolveReference(token, type, byFqn, bySimple);
          if (target && !endpoint.typeIds.includes(target.id)) endpoint.typeIds.push(target.id);
        }
      }
      const sourceMethod = type.methods.find((method) => method.name === endpoint.javaMethod && method.line === endpoint.line);
      endpoint.callTargets = sourceMethod?.callTargets || [];
    }
  }
  const controllers = types.filter((type) => type.stereotype === 'controller' && type.endpoints.length);
  if (!files.length) warnings.push('No Java source files were found.');
  if (!controllers.length && files.length) warnings.push('No annotated Spring MVC controllers with endpoints were found.');
  return { root: absoluteRoot, files, types, controllers, warnings };
}

export { normalizeRoute, splitTopLevel, stableId, unwrapType };
