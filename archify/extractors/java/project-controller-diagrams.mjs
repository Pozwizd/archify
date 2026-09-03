function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function packageId(packageName) {
  const cleaned = `pkg_${packageName || 'default'}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return /^[a-zA-Z]/.test(cleaned) ? cleaned : `pkg_${cleaned}`;
}

function relationId(prefix, from, to) {
  return `${prefix}_${from}_${to}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function displayType(value) {
  return String(value || '').replace(/\b(?:[a-z_]\w*\.)+([A-Z]\w*)\b/g, '$1').replace(/\s+/g, ' ').trim();
}

function memberHeight(type) {
  const fieldCount = type.fields?.length || 0;
  const methodCount = type.methods?.length || 0;
  const sections = (fieldCount ? 1 : 0) + (methodCount ? 1 : 0);
  return Math.max(84, 54 + (fieldCount + methodCount) * 17 + sections * 10);
}

function memberWidth(type) {
  const visibility = { public: '+', private: '−', protected: '#', package: '~' };
  const lines = type.kind === 'enum' ? (type.values || []) : [
    ...(type.fields || []).map((field) => `${visibility[field.visibility]} ${field.name}: ${field.type}${field.static ? ' {static}' : ''}${field.final ? ' {readOnly}' : ''}`),
    ...(type.methods || []).map((method) => `${visibility[method.visibility]} ${method.name}(${(method.parameters || []).map((item) => `${item.name}: ${item.type}`).join(', ')}): ${method.returns || 'void'}${method.static ? ' {static}' : ''}${method.abstract ? ' {abstract}' : ''}`),
  ];
  const longest = Math.max(textUnits(type.name), ...lines.map(textUnits));
  return Math.max(260, Math.ceil(longest * 5.1 + 32));
}

function umlType(type, packageIds, endpointChunk, activeMethods, selected) {
  const methods = type.stereotype === 'controller'
    ? endpointChunk.map((endpoint) => ({
      visibility: 'public',
      name: endpoint.javaMethod,
      parameters: endpoint.parameters.map((parameter) => ({ name: parameter.name, type: displayType(parameter.type) })),
      returns: displayType(endpoint.returnType) || 'void',
    }))
    : type.methods.filter((method) => method.visibility === 'public' && (!activeMethods?.size || activeMethods.has(method.name))).slice(0, 3).map((method) => ({
      visibility: method.visibility,
      name: method.name,
      parameters: method.parameters.slice(0, 4).map((parameter) => ({ name: parameter.name, type: displayType(parameter.type) })),
      returns: displayType(method.returns) || 'void',
      ...(method.static ? { static: true } : {}),
      ...(method.abstract ? { abstract: true } : {}),
    }));
  const fields = type.fields.filter((field) => !field.targetId || selected.has(field.targetId)).slice(0, 4).map((field) => ({
    visibility: field.visibility,
    name: field.name,
    type: displayType(field.type),
    ...(field.static ? { static: true } : {}),
    ...(field.final ? { final: true } : {}),
  }));
  return {
    id: type.id,
    kind: type.kind,
    name: type.name,
    package: packageIds.get(type.packageName),
    ...(type.stereotype ? { stereotype: type.stereotype } : {}),
    ...(type.kind === 'enum' ? { values: type.enumValues || [] } : { fields, methods }),
  };
}

function roleRank(type) {
  if (type.stereotype === 'controller') return 0;
  if (type.stereotype === 'dto') return 1;
  if (type.stereotype === 'service' || type.kind === 'interface') return 1;
  if (type.stereotype === 'mapper' || type.stereotype === 'repository') return 2;
  if (type.stereotype === 'entity' || type.kind === 'enum') return 2;
  return 2;
}

function layOut(types) {
  let x = 40;
  let y = 42;
  let rowHeight = 0;
  types.sort((left, right) => roleRank(left) - roleRank(right) || left.name.localeCompare(right.name));
  for (const type of types) {
    const height = memberHeight(type);
    const width = memberWidth(type);
    if (x > 40 && x + width > 1500) {
      x = 40;
      y += rowHeight + 56;
      rowHeight = 0;
    }
    type.pos = [x, y];
    type.size = [width, height];
    x += width + 64;
    rowHeight = Math.max(rowHeight, height);
  }
}

function selectForEndpoint(model, controller, endpoint, depth) {
  const byId = new Map(model.types.map((type) => [type.id, type]));
  const selected = new Set([controller.id, ...endpoint.typeIds]);
  let frontier = [{ typeId: controller.id, method: endpoint.javaMethod }];
  const visited = new Set();
  const methodsByType = new Map();
  for (let level = 0; level <= depth && frontier.length; level += 1) {
    const next = [];
    for (const item of frontier) {
      const visitKey = `${item.typeId}|${item.method || '*'}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      if (item.method) methodsByType.set(item.typeId, new Set([...(methodsByType.get(item.typeId) || []), item.method]));
      const type = byId.get(item.typeId);
      if (!type) continue;
      const methods = item.method ? type.methods.filter((method) => method.name === item.method) : [];
      for (const method of methods) {
        for (const typeId of method.typeIds || []) selected.add(typeId);
        for (const call of method.callTargets || []) {
          selected.add(call.target);
          next.push({ typeId: call.target, method: call.method });
        }
      }
      for (const implementation of model.types.filter((candidate) => candidate.implementsIds.includes(type.id))) {
        selected.add(implementation.id);
        next.push({ typeId: implementation.id, method: item.method });
      }
    }
    frontier = next;
  }
  return { types: selected, methodsByType };
}

function relationshipsFor(model, selected, controller, endpointChunk, activeMethods) {
  const relations = [];
  const seen = new Set();
  const add = (relation) => {
    const key = `${relation.from}|${relation.to}|${relation.kind}`;
    if (relation.from !== relation.to && selected.has(relation.from) && selected.has(relation.to) && !seen.has(key)) {
      seen.add(key);
      relations.push({ id: relationId(relation.kind, relation.from, relation.to), ...relation });
    }
  };
  for (const type of model.types) {
    if (!selected.has(type.id)) continue;
    if (type.extendsId) add({ from: type.id, to: type.extendsId, kind: 'inheritance' });
    for (const parent of type.implementsIds) add({ from: type.id, to: parent, kind: 'realization' });
    for (const dependency of type.dependencies) {
      const methodName = dependency.reason.match(/^method\s+(.+)$/)?.[1];
      if (methodName && activeMethods.get(type.id)?.size && !activeMethods.get(type.id).has(methodName)) continue;
      add({ from: type.id, to: dependency.target, kind: 'dependency', label: dependency.reason.replace(/^field /, 'uses ') });
    }
  }
  for (const endpoint of endpointChunk) {
    for (const typeId of endpoint.typeIds) {
      add({ from: controller.id, to: typeId, kind: 'dependency', label: 'request/response' });
    }
  }
  return relations;
}

export function projectControllerDiagrams(model, options = {}) {
  const scenariosPerDiagram = options.scenariosPerDiagram || 3;
  const relationDepth = options.relationDepth ?? 2;
  const maxTypes = options.maxTypes || 15;
  const controllerFilter = options.controller?.toLowerCase();
  const packageFilter = options.packageName;
  const controllers = model.controllers.filter((controller) => (
    (!controllerFilter || controller.name.toLowerCase() === controllerFilter || controller.fqn.toLowerCase() === controllerFilter)
    && (!packageFilter || controller.packageName.startsWith(packageFilter))
  ));
  const results = [];
  const warnings = [...model.warnings];
  for (const controller of controllers) {
    const orderedEndpoints = controller.endpoints.slice().sort((left, right) => (
      left.path.localeCompare(right.path) || left.httpMethod.localeCompare(right.httpMethod) || left.javaMethod.localeCompare(right.javaMethod)
    ));
    const endpointChunks = chunks(orderedEndpoints, scenariosPerDiagram);
    for (const [chunkIndex, endpointChunk] of endpointChunks.entries()) {
      const endpointSelections = endpointChunk.map((endpoint) => selectForEndpoint(model, controller, endpoint, relationDepth));
      const combined = new Set(endpointSelections.flatMap((selection) => [...selection.types]));
      const activeMethods = new Map();
      for (const selection of endpointSelections) {
        for (const [typeId, names] of selection.methodsByType) {
          activeMethods.set(typeId, new Set([...(activeMethods.get(typeId) || []), ...names]));
        }
      }
      const priority = [controller, ...model.types.filter((type) => combined.has(type.id) && type.id !== controller.id)]
        .sort((left, right) => (left.id === controller.id ? -1 : right.id === controller.id ? 1 : roleRank(left) - roleRank(right) || left.name.localeCompare(right.name)));
      const selectedTypes = priority.slice(0, maxTypes);
      const selected = new Set(selectedTypes.map((type) => type.id));
      if (priority.length > maxTypes) warnings.push(`${controller.name} diagram ${chunkIndex + 1}: ${priority.length - maxTypes} secondary types omitted by --max-types ${maxTypes}.`);
      const packageNames = [...new Set(selectedTypes.map((type) => type.packageName))].sort();
      const packageIds = new Map(packageNames.map((name) => [name, packageId(name)]));
      const types = selectedTypes.map((type) => umlType(type, packageIds, endpointChunk, activeMethods.get(type.id), selected));
      layOut(types);
      const views = endpointChunk.map((endpoint, index) => ({
        id: `endpoint_${chunkIndex + 1}_${index + 1}`,
        label: `${endpoint.httpMethod} ${endpoint.path}`.slice(0, 48),
        focus: [...endpointSelections[index].types].filter((id) => selected.has(id)),
        note: `${controller.name}.${endpoint.javaMethod}(), line ${endpoint.line}`.slice(0, 140),
      }));
      const suffix = endpointChunks.length > 1 ? ` · ${chunkIndex + 1}/${endpointChunks.length}` : '';
      const diagram = {
        schema_version: 1,
        diagram_type: 'class-diagram',
        meta: {
          title: `${controller.name}${suffix}`,
          quality_profile: 'standard',
          visual_preset: 'blueprint',
          views,
        },
        packages: packageNames.map((name) => ({ id: packageIds.get(name), label: name || '(default package)' })),
        types,
        relationships: relationshipsFor(model, selected, controller, endpointChunk, activeMethods),
      };
      const slug = controller.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
      const id = endpointChunks.length > 1 ? `${slug}-${chunkIndex + 1}` : slug;
      results.push({
        id,
        controller,
        endpoints: endpointChunk,
        diagram,
        evidence: selectedTypes.map((type) => ({ id: type.id, fqn: type.fqn, path: type.file, line: type.line })),
      });
    }
  }
  if (!results.length && model.controllers.length && (controllerFilter || packageFilter)) {
    warnings.push('No controllers matched the requested --controller or --package filter.');
  }
  return { diagrams: results, warnings };
}
import { textUnits } from '../../renderers/shared/utils.mjs';
