import { textUnits } from '../../renderers/shared/utils.mjs';

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
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
  return Math.max(220, Math.ceil(longest * 5.1 + 32));
}

function onboardingStageLabel(stage, locale) {
  const labels = locale === 'ru'
    ? ['вход', 'контроллер', 'сервис', 'реализация', 'данные', 'ответ']
    : ['request', 'controller', 'service', 'implementation', 'data', 'response'];
  return `${stage + 1} · ${labels[stage]}`;
}

function umlType(type, endpoint, selection, selected, stage, options) {
  const activeMethods = selection.methodsByType.get(type.id);
  const activeFields = selection.fieldsByType.get(type.id);
  const methods = type.stereotype === 'controller'
    ? [{
      visibility: 'public',
      name: endpoint.javaMethod,
      parameters: endpoint.parameters.slice(0, 4).map((parameter) => ({ name: parameter.name, type: displayType(parameter.type) })),
      returns: displayType(endpoint.returnType) || 'void',
    }]
    : type.methods.filter((method) => method.visibility === 'public' && activeMethods?.has(method.name)).slice(0, 3).map((method) => ({
      visibility: method.visibility,
      name: method.name,
      ...(method.static ? { static: true } : {}),
      ...(method.abstract ? { abstract: true } : {}),
    }));
  const exposeState = ['dto', 'entity'].includes(type.stereotype);
  const fields = type.fields.filter((field) => (
    exposeState && (!field.targetId || selected.has(field.targetId)) && (!activeFields?.size || activeFields.has(field.name) || !field.targetId)
  )).slice(0, 4).map((field) => ({
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
    ...(options.mode === 'onboarding'
      ? { stereotype: onboardingStageLabel(stage, options.locale) }
      : type.stereotype ? { stereotype: type.stereotype } : {}),
    ...(type.kind === 'enum' ? { values: type.enumValues || [] } : { fields, methods }),
  };
}

function roleRank(type) {
  if (type.stereotype === 'controller') return 0;
  if (type.stereotype === 'dto') return 1;
  if (type.stereotype === 'service') return 2;
  if (type.stereotype === 'mapper') return 3;
  if (type.stereotype === 'repository') return 4;
  if (type.stereotype === 'entity' || type.kind === 'enum') return 5;
  if (type.kind === 'interface') return 2;
  return 3;
}

function selectForEndpoint(model, controller, endpoint, depth) {
  const byId = new Map(model.types.map((type) => [type.id, type]));
  const selected = new Set([controller.id, ...endpoint.typeIds]);
  let frontier = [{ typeId: controller.id, method: endpoint.javaMethod }];
  const visited = new Set();
  const methodsByType = new Map();
  const fieldsByType = new Map();
  const depthByType = new Map([[controller.id, 0]]);
  const callEdges = [];
  const realizationEdges = [];
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
          depthByType.set(call.target, Math.min(depthByType.get(call.target) ?? Infinity, level + 1));
          fieldsByType.set(type.id, new Set([...(fieldsByType.get(type.id) || []), call.receiver]));
          callEdges.push({ from: type.id, to: call.target, kind: 'dependency', label: call.method });
          next.push({ typeId: call.target, method: call.method });
        }
      }
      for (const implementation of model.types.filter((candidate) => candidate.implementsIds.includes(type.id))) {
        selected.add(implementation.id);
        depthByType.set(implementation.id, Math.min(depthByType.get(implementation.id) ?? Infinity, level + 1));
        realizationEdges.push({ from: implementation.id, to: type.id, kind: 'realization' });
        next.push({ typeId: implementation.id, method: item.method });
      }
    }
    frontier = next;
  }
  return { types: selected, methodsByType, fieldsByType, depthByType, callEdges, realizationEdges };
}

function scenarioStage(type, endpoint, controller, selection) {
  if ((endpoint.parameterTypeIds || []).includes(type.id)) return 0;
  if (type.id === controller.id) return 1;
  if ((endpoint.returnTypeIds || []).includes(type.id)) return 5;
  if (type.stereotype === 'repository' || type.stereotype === 'mapper' || type.stereotype === 'entity' || type.kind === 'enum') return 4;
  if (type.implementsIds?.length) return 3;
  const depth = selection.depthByType.get(type.id) ?? 4;
  return Math.min(4, Math.max(2, depth + 1));
}

function cloneId(sourceId, scenarioId) {
  return `${sourceId}__${scenarioId}`;
}

function cloneRelationships(selection, endpoint, controller, selected, aliases, scenarioId) {
  const relationships = [];
  const seen = new Set();
  const add = (relation) => {
    const key = `${relation.from}|${relation.to}|${relation.kind}|${relation.label || ''}`;
    if (relation.from === relation.to || !selected.has(relation.from) || !selected.has(relation.to) || seen.has(key)) return;
    seen.add(key);
    relationships.push({
      id: `r_${scenarioId}_${relationships.length + 1}`,
      from: aliases.get(relation.from),
      to: aliases.get(relation.to),
      kind: relation.kind,
      ...(relation.label ? { label: relation.label } : {}),
    });
  };
  for (const relation of selection.callEdges) add(relation);
  for (const relation of selection.realizationEdges) add(relation);
  for (const typeId of endpoint.parameterTypeIds || []) add({ from: typeId, to: controller.id, kind: 'dependency', label: 'request' });
  for (const typeId of endpoint.returnTypeIds || []) add({ from: controller.id, to: typeId, kind: 'dependency', label: 'response' });
  return relationships;
}

function onboardingCards(controller, endpoint, typeCount, relationshipCount, locale) {
  const russianCount = (value, forms) => {
    const mod100 = value % 100;
    const mod10 = value % 10;
    return `${value} ${mod100 >= 11 && mod100 <= 14 ? forms[2] : mod10 === 1 ? forms[0] : mod10 >= 2 && mod10 <= 4 ? forms[1] : forms[2]}`;
  };
  if (locale === 'ru') {
    return [
      {
        dot: 'cyan',
        title: 'Как читать схему',
        items: [
          'Следуйте слева направо: вход → контроллер → сервис → реализация → данные → ответ.',
          'Номер над классом показывает этап сценария, а не порядок выполнения каждой внутренней операции.',
          'Нажмите на класс, чтобы увидеть его входящие и исходящие зависимости.',
        ],
      },
      {
        dot: 'emerald',
        title: 'Точка входа',
        items: [
          `${endpoint.httpMethod} ${endpoint.path}`,
          `${controller.name}.${endpoint.javaMethod}() · строка ${endpoint.line}`,
          `В схеме: ${russianCount(typeCount, ['класс', 'класса', 'классов'])} и ${russianCount(relationshipCount, ['связь', 'связи', 'связей'])}.`,
        ],
      },
    ];
  }
  return [
    {
      dot: 'cyan',
      title: 'How to read this diagram',
      items: [
        'Follow left to right: request → controller → service → implementation → data → response.',
        'The number above a class marks its scenario stage, not the exact order of every internal operation.',
        'Select a class to inspect its incoming and outgoing dependencies.',
      ],
    },
    {
      dot: 'emerald',
      title: 'Entry point',
      items: [
        `${endpoint.httpMethod} ${endpoint.path}`,
        `${controller.name}.${endpoint.javaMethod}() · line ${endpoint.line}`,
        `Scope: ${typeCount} types and ${relationshipCount} relationships.`,
      ],
    },
  ];
}

function layOutScenarioLanes(lanes) {
  const slotWidths = new Map();
  for (const lane of lanes) {
    const counts = new Map();
    for (const type of lane.types) {
      const index = counts.get(type.stage) || 0;
      counts.set(type.stage, index + 1);
      type.row = index % 2;
      type.slot = `${type.stage}:${Math.floor(index / 2)}`;
      type.size = [memberWidth(type), memberHeight(type)];
      slotWidths.set(type.slot, Math.max(slotWidths.get(type.slot) || 0, type.size[0]));
    }
  }
  const slots = [...slotWidths.keys()].sort((left, right) => {
    const [leftStage, leftIndex] = left.split(':').map(Number);
    const [rightStage, rightIndex] = right.split(':').map(Number);
    return leftStage - rightStage || leftIndex - rightIndex;
  });
  const slotX = new Map();
  let x = 40;
  let previousStage = null;
  for (const slot of slots) {
    const stage = Number(slot.split(':')[0]);
    if (previousStage !== null) x += stage === previousStage ? 48 : 88;
    slotX.set(slot, x);
    x += slotWidths.get(slot);
    previousStage = stage;
  }
  let y = 42;
  for (const lane of lanes) {
    const rowHeights = [0, 0];
    for (const type of lane.types) rowHeights[type.row] = Math.max(rowHeights[type.row], type.size[1]);
    const secondRowY = y + rowHeights[0] + (rowHeights[1] ? 42 : 0);
    const laneHeight = rowHeights[0] + (rowHeights[1] ? 42 + rowHeights[1] : 0);
    for (const type of lane.types) {
      const rowY = type.row === 0 ? y : secondRowY;
      type.pos = [slotX.get(type.slot), rowY + Math.round((rowHeights[type.row] - type.size[1]) / 2)];
      delete type.slot;
      delete type.row;
      delete type.stage;
    }
    y += laneHeight + 110;
  }
}

export function projectControllerDiagrams(model, options = {}) {
  const mode = options.mode || 'onboarding';
  const scenariosPerDiagram = options.scenariosPerDiagram || (mode === 'onboarding' ? 1 : 3);
  const relationDepth = options.relationDepth ?? 2;
  const maxTypes = options.maxTypes || (mode === 'onboarding' ? 7 : 8);
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
      const lanes = [];
      const evidence = [];
      for (const [scenarioIndex, endpoint] of endpointChunk.entries()) {
        const scenarioId = `s${chunkIndex + 1}_${scenarioIndex + 1}`;
        const selection = selectForEndpoint(model, controller, endpoint, relationDepth);
        const candidates = model.types.filter((type) => selection.types.has(type.id));
        const ordered = [controller, ...candidates.filter((type) => type.id !== controller.id).sort((left, right) => (
          scenarioStage(left, endpoint, controller, selection) - scenarioStage(right, endpoint, controller, selection)
          || (selection.depthByType.get(left.id) ?? 99) - (selection.depthByType.get(right.id) ?? 99)
          || roleRank(left) - roleRank(right)
          || left.name.localeCompare(right.name)
        ))];
        const selectedTypes = ordered.slice(0, maxTypes);
        const selected = new Set(selectedTypes.map((type) => type.id));
        if (ordered.length > maxTypes) warnings.push(options.locale === 'ru'
          ? `${controller.name}.${endpoint.javaMethod}: скрыто второстепенных типов: ${ordered.length - maxTypes} (лимит --max-types ${maxTypes}).`
          : `${controller.name}.${endpoint.javaMethod}: ${ordered.length - maxTypes} secondary types omitted by --max-types ${maxTypes}.`);
        const aliases = new Map(selectedTypes.map((type) => [type.id, cloneId(type.id, scenarioId)]));
        const types = selectedTypes.map((type) => {
          const stage = scenarioStage(type, endpoint, controller, selection);
          return {
            ...umlType(type, endpoint, selection, selected, stage, { mode, locale: options.locale }),
            id: aliases.get(type.id),
            stage,
          };
        }).sort((left, right) => left.stage - right.stage || left.name.localeCompare(right.name));
        const relationships = cloneRelationships(selection, endpoint, controller, selected, aliases, scenarioId);
        lanes.push({ scenarioId, endpoint, types, relationships });
        evidence.push(...selectedTypes.map((type) => ({
          id: aliases.get(type.id), sourceId: type.id, endpoint: endpoint.id,
          fqn: type.fqn, path: type.file, line: type.line,
        })));
      }
      layOutScenarioLanes(lanes);
      const types = lanes.flatMap((lane) => lane.types);
      const relationships = lanes.flatMap((lane) => lane.relationships);
      const views = lanes.map((lane, index) => ({
        id: `endpoint_${chunkIndex + 1}_${index + 1}`,
        label: `${lane.endpoint.httpMethod} ${lane.endpoint.path}`.slice(0, 48),
        focus: lane.types.map((type) => type.id),
        note: `${controller.name}.${lane.endpoint.javaMethod}() · ${options.locale === 'ru' ? 'строка' : 'line'} ${lane.endpoint.line}`.slice(0, 140),
      }));
      const suffix = mode === 'onboarding' && endpointChunk.length === 1
        ? ` · ${endpointChunk[0].httpMethod} ${endpointChunk[0].path}`
        : endpointChunks.length > 1 ? ` · ${chunkIndex + 1}/${endpointChunks.length}` : '';
      const diagram = {
        schema_version: 1,
        diagram_type: 'class-diagram',
        meta: {
          title: `${controller.name}${suffix}`,
          quality_profile: 'standard',
          visual_preset: 'blueprint',
          views,
        },
        packages: [],
        types,
        relationships,
        ...(mode === 'onboarding' && endpointChunk.length === 1
          ? { cards: onboardingCards(controller, endpointChunk[0], types.length, relationships.length, options.locale) }
          : {}),
      };
      const slug = controller.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
      const id = endpointChunks.length > 1 ? `${slug}-${chunkIndex + 1}` : slug;
      results.push({ id, controller, endpoints: endpointChunk, diagram, evidence });
    }
  }
  if (!results.length && model.controllers.length && (controllerFilter || packageFilter)) {
    warnings.push(options.locale === 'ru'
      ? 'Ни один контроллер не соответствует фильтру --controller или --package.'
      : 'No controllers matched the requested --controller or --package filter.');
  }
  return { diagrams: results, warnings };
}
