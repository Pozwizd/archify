import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, renderDefinitions, renderSemanticSigil, textUnits } from '../shared/utils.mjs';
import {
  animateAttr,
  focusEdgeAttrs,
  focusNodeAttrs,
  focusNodeTitle,
  loadDiagram,
  svgAccessibleText,
  svgRootAttrs,
  writeDiagram,
} from '../shared/cli.mjs';
import { throwDiagnosticProblems } from '../shared/diagnostics.mjs';
import { legendFootprint, resolveLegend, renderLegend as renderResolvedLegend } from '../shared/legend.mjs';
import {
  cleanFlowProblems,
  labelPoint,
  rectsOverlap,
  roundedPath,
  routePointsValue,
  segmentIntersectsRect,
} from '../shared/geometry.mjs';
import { translateMessage as i18nText } from '../shared/i18n.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { diagram, template, outPath } = loadDiagram({
  rendererDir: __dirname,
  diagramType: 'class-diagram',
  defaultExample: 'booking-domain.class-diagram.json',
});

const layout = {
  margin: 40,
  top: 54,
  gapX: 64,
  gapY: 120,
  memberLineH: 17,
  headerH: 54,
  sectionPad: 10,
  legendH: 60,
};

const kindTone = {
  class: ['backend', 'c-backend'],
  'abstract-class': ['cloud', 'c-cloud'],
  interface: ['frontend', 'c-frontend'],
  enum: ['database', 'c-database'],
};

const visibilityMark = {
  public: '+',
  private: '−',
  protected: '#',
  package: '~',
};

const relationshipKinds = [
  'inheritance',
  'realization',
  'dependency',
  'association',
  'aggregation',
  'composition',
];

const LEGEND_CATALOG = relationshipKinds.map((kind) => ({
  kind,
  label: i18nText(diagram.meta.locale, `legend.class-diagram.${kind}`),
}));

function fieldText(field) {
  const modifiers = `${field.static ? ' {static}' : ''}${field.final ? ' {readOnly}' : ''}`;
  return `${visibilityMark[field.visibility]} ${field.name}: ${field.type}${modifiers}`;
}

function methodText(method) {
  const parameters = (method.parameters || []).map((item) => `${item.name}: ${item.type}`).join(', ');
  const result = method.returns ? `: ${method.returns}` : '';
  const modifiers = `${method.static ? ' {static}' : ''}${method.abstract ? ' {abstract}' : ''}`;
  return `${visibilityMark[method.visibility]} ${method.name}(${parameters})${result}${modifiers}`;
}

function typeLines(type) {
  if (type.kind === 'enum') return (type.values || []).slice();
  return [
    ...(type.fields || []).map(fieldText),
    ...(type.methods || []).map(methodText),
  ];
}

function measuredSize(type) {
  const fieldLines = type.kind === 'enum' ? (type.values || []) : (type.fields || []).map(fieldText);
  const methodLines = type.kind === 'enum' ? [] : (type.methods || []).map(methodText);
  const headerUnits = Math.max(textUnits(type.name), textUnits(type.stereotype || ''), textUnits(type.package || ''));
  const memberUnits = Math.max(0, ...fieldLines.map(textUnits), ...methodLines.map(textUnits));
  const width = Math.max(220, Math.min(380, Math.ceil(Math.max(headerUnits * 7, memberUnits * 5.1) + 28)));
  const sections = (fieldLines.length ? 1 : 0) + (methodLines.length ? 1 : 0);
  const contentLines = fieldLines.length + methodLines.length;
  const height = Math.max(84, layout.headerH + contentLines * layout.memberLineH + sections * layout.sectionPad);
  return Array.isArray(type.size) ? type.size : [width, height];
}

const sourceTypes = Array.isArray(diagram.types) ? diagram.types : [];
const hierarchy = (diagram.relationships || []).filter((relation) => ['inheritance', 'realization'].includes(relation.kind));
const levels = new Map(sourceTypes.map((type) => [type.id, 0]));
let hierarchyChanged = false;
for (let pass = 0; pass < sourceTypes.length; pass += 1) {
  hierarchyChanged = false;
  for (const relation of hierarchy) {
    const next = (levels.get(relation.to) || 0) + 1;
    if ((levels.get(relation.from) || 0) < next) {
      levels.set(relation.from, next);
      hierarchyChanged = true;
    }
  }
  if (!hierarchyChanged) break;
}

const rankOffsets = new Map();
const measured = sourceTypes.map((type) => {
  const [width, height] = measuredSize(type);
  const rank = levels.get(type.id) || 0;
  const rankIndex = rankOffsets.get(rank) || 0;
  rankOffsets.set(rank, rankIndex + 1);
  const x = type.pos?.[0] ?? layout.margin + rankIndex * (380 + layout.gapX);
  const y = type.pos?.[1] ?? layout.top + rank * (260 + layout.gapY);
  return { ...type, x, y, width, height, cx: x + width / 2, cy: y + height / 2 };
});
const types = new Map(measured.map((type) => [type.id, type]));
const packages = new Map((diagram.packages || []).map((item) => [item.id, item]));
const routeCache = new WeakMap();

const maxX = Math.max(480, ...measured.map((type) => type.x + type.width + layout.margin));
const maxY = Math.max(260, ...measured.map((type) => type.y + type.height + layout.margin));
const legendEntries = resolveLegend(
  diagram.meta?.legend,
  LEGEND_CATALOG,
  new Set((diagram.relationships || []).map((relation) => relation.kind)),
);
const footprint = legendFootprint(legendEntries, { width: Math.max(1, maxX - layout.margin * 2) });
const viewBox = diagram.meta?.viewBox || [
  Math.ceil(maxX),
  Math.ceil(maxY + layout.legendH + footprint.extraHeight),
];

function validateClassDiagram() {
  const problems = [];
  if (types.size !== sourceTypes.length) problems.push('Type ids must be unique.');
  if (packages.size !== (diagram.packages || []).length) problems.push('Package ids must be unique.');
  if (hierarchyChanged && sourceTypes.length) {
    problems.push('Inheritance and realization relationships contain a cycle — remove the cyclic generalization.');
  }
  for (const type of measured) {
    if (type.package && !packages.has(type.package)) {
      problems.push(`Type "${type.id}" references unknown package "${type.package}".`);
    }
    if (type.x < 0 || type.y < 0 || type.x + type.width > viewBox[0] || type.y + type.height > viewBox[1]) {
      problems.push(`Type "${type.id}" falls outside the viewBox ${viewBox[0]}x${viewBox[1]}.`);
    }
    for (const line of typeLines(type)) {
      if (textUnits(line) * 5.1 > type.width - 20) {
        problems.push(`Member "${line}" does not fit type "${type.id}" — widen size or shorten the signature.`);
      }
    }
  }
  for (let left = 0; left < measured.length; left += 1) {
    for (let right = left + 1; right < measured.length; right += 1) {
      if (rectsOverlap(measured[left], measured[right], 12)) {
        problems.push(`Types "${measured[left].id}" and "${measured[right].id}" overlap or have less than 12px clearance.`);
      }
    }
  }
  for (const [index, relation] of (diagram.relationships || []).entries()) {
    if (!types.has(relation.from)) problems.push(`/relationships/${index}/from references unknown type "${relation.from}".`);
    if (!types.has(relation.to)) problems.push(`/relationships/${index}/to references unknown type "${relation.to}".`);
    if (relation.from === relation.to) problems.push(`/relationships/${index} must not connect type "${relation.from}" to itself.`);
  }
  const routable = (diagram.relationships || []).filter((relation) => (
    relation.from !== relation.to && types.has(relation.from) && types.has(relation.to)
  ));
  problems.push(...cleanFlowProblems({
    relations: routable,
    obstacles: measured,
    pathFor: (relation) => ({ points: pathFor(relation) }),
    diagramType: 'class-diagram',
    relationCollection: 'relationships',
    obstacleKind: 'type',
    routeHint: 'move the type or leave enough horizontal/vertical corridor space for automatic routing',
  }));
  if (problems.length) {
    throwDiagnosticProblems('Class diagram validation failed', problems, {
      code: 'class-diagram/invalid',
      subject: { diagramType: 'class-diagram' },
    });
  }
}

function anchorPair(relation) {
  const from = types.get(relation.from);
  const to = types.get(relation.to);
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? [[from.x + from.width, from.cy], [to.x, to.cy]]
      : [[from.x, from.cy], [to.x + to.width, to.cy]];
  }
  return dy >= 0
    ? [[from.cx, from.y + from.height], [to.cx, to.y]]
    : [[from.cx, from.y], [to.cx, to.y + to.height]];
}

function compactRoute(points) {
  const compact = [];
  for (const point of points) {
    const previous = compact[compact.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) compact.push(point);
  }
  let index = 1;
  while (index < compact.length - 1) {
    const previous = compact[index - 1];
    const current = compact[index];
    const next = compact[index + 1];
    if ((previous[0] === current[0] && current[0] === next[0]) || (previous[1] === current[1] && current[1] === next[1])) {
      compact.splice(index, 1);
    } else {
      index += 1;
    }
  }
  return compact;
}

function routeIsClear(points, relation) {
  const endpoints = new Set([relation.from, relation.to]);
  return points.every(([x, y]) => x >= 4 && y >= 4 && x <= viewBox[0] - 4 && y <= viewBox[1] - 4)
    && measured.every((type) => endpoints.has(type.id) || points.slice(0, -1).every((start, index) => (
      !segmentIntersectsRect({ start, end: points[index + 1] }, type, 6)
    )));
}

function routeScore(points) {
  const length = points.slice(0, -1).reduce((sum, point, index) => (
    sum + Math.abs(points[index + 1][0] - point[0]) + Math.abs(points[index + 1][1] - point[1])
  ), 0);
  return length + Math.max(0, points.length - 2) * 24;
}

function pathFor(relation) {
  if (routeCache.has(relation)) return routeCache.get(relation);
  const [start, end] = anchorPair(relation);
  const candidates = start[0] === end[0] || start[1] === end[1] ? [[start, end]] : [];
  if (Math.abs(end[0] - start[0]) >= Math.abs(end[1] - start[1])) {
    const middle = (start[0] + end[0]) / 2;
    candidates.push([start, [middle, start[1]], [middle, end[1]], end]);
    const direction = end[0] >= start[0] ? 1 : -1;
    const startStub = [start[0] + direction * 18, start[1]];
    const endStub = [end[0] - direction * 18, end[1]];
    const channels = new Set([(start[1] + end[1]) / 2]);
    for (const type of measured) {
      if (type.id === relation.from || type.id === relation.to) continue;
      channels.add(type.y - 18);
      channels.add(type.y + type.height + 18);
    }
    for (const channelY of channels) {
      candidates.push([start, startStub, [startStub[0], channelY], [endStub[0], channelY], endStub, end]);
    }
  } else {
    const middle = (start[1] + end[1]) / 2;
    candidates.push([start, [start[0], middle], [end[0], middle], end]);
    const direction = end[1] >= start[1] ? 1 : -1;
    const startStub = [start[0], start[1] + direction * 18];
    const endStub = [end[0], end[1] - direction * 18];
    const channels = new Set([(start[0] + end[0]) / 2]);
    for (const type of measured) {
      if (type.id === relation.from || type.id === relation.to) continue;
      channels.add(type.x - 18);
      channels.add(type.x + type.width + 18);
    }
    for (const channelX of channels) {
      candidates.push([start, startStub, [channelX, startStub[1]], [channelX, endStub[1]], endStub, end]);
    }
  }
  const clear = candidates.map(compactRoute).filter((points) => routeIsClear(points, relation));
  const route = (clear.length ? clear : candidates.map(compactRoute)).sort((left, right) => routeScore(left) - routeScore(right))[0];
  routeCache.set(relation, route);
  return route;
}

function markerAttrs(relation) {
  if (relation.kind === 'inheritance') return 'marker-end="url(#uml-inheritance)"';
  if (relation.kind === 'realization') return 'marker-end="url(#uml-realization)"';
  if (relation.kind === 'dependency') return 'marker-end="url(#arrowhead-dashed)"';
  if (relation.kind === 'aggregation') return 'marker-start="url(#uml-aggregation)"';
  if (relation.kind === 'composition') return 'marker-start="url(#uml-composition)"';
  if (relation.navigability === 'to') return 'marker-end="url(#arrowhead)"';
  if (relation.navigability === 'from') return 'marker-start="url(#arrowhead)"';
  if (relation.navigability === 'both') return 'marker-start="url(#arrowhead)" marker-end="url(#arrowhead)"';
  return '';
}

function relationClass(relation) {
  return ['realization', 'dependency'].includes(relation.kind) ? 'a-dashed' : 'a-default';
}

function renderRelationship(relation, index) {
  const points = pathFor(relation);
  return `        <path ${focusEdgeAttrs(relation.from, relation.to, relation.label, index, relation.id)} data-edge-kind="${esc(relation.kind)}" data-composition-points="${routePointsValue(points)}" d="${roundedPath(points, 7)}" class="${relationClass(relation)}"${animateAttr(diagram.meta, 'edge', index)} stroke-width="1.5" ${markerAttrs(relation)}/>`;
}

function renderRelationshipDetail(relation, index) {
  const points = pathFor(relation);
  const [lx, ly] = labelPoint(relation, points);
  const label = relation.label || '';
  const labelWidth = label ? Math.max(30, textUnits(label) * 4.8 + 10) : 0;
  const fromText = relation.fromMultiplicity || '';
  const toText = relation.toMultiplicity || '';
  const start = points[0];
  const end = points[points.length - 1];
  return `        <g data-detail="context" ${focusEdgeAttrs(relation.from, relation.to, relation.label, index, relation.id)}>
          ${label ? `<rect x="${lx - labelWidth / 2}" y="${ly - 10}" width="${labelWidth}" height="14" rx="3" class="c-mask"/><text x="${lx}" y="${ly}" class="t-muted" font-size="8" text-anchor="middle">${esc(label)}</text>` : ''}
          ${fromText ? `<text x="${start[0] + 8}" y="${start[1] - 7}" class="t-muted" font-size="8">${esc(fromText)}</text>` : ''}
          ${toText ? `<text x="${end[0] - 8}" y="${end[1] - 7}" class="t-muted" font-size="8" text-anchor="end">${esc(toText)}</text>` : ''}
        </g>`;
}

function renderType(type, index) {
  const [tone, fill] = kindTone[type.kind] || kindTone.class;
  const packageLabel = type.package ? packages.get(type.package)?.label : '';
  const stereotype = type.stereotype || (type.kind === 'abstract-class' ? 'abstract' : type.kind === 'class' ? '' : type.kind);
  const fields = type.kind === 'enum' ? (type.values || []) : (type.fields || []).map(fieldText);
  const methods = type.kind === 'enum' ? [] : (type.methods || []).map(methodText);
  let cursor = type.y + layout.headerH + layout.sectionPad;
  const renderLines = (lines) => lines.map((line) => {
    const text = `<text x="${type.x + 10}" y="${cursor}" class="t-primary" font-size="8">${esc(line)}</text>`;
    cursor += layout.memberLineH;
    return text;
  }).join('\n          ');
  const fieldSvg = renderLines(fields);
  const methodDividerY = cursor + (fields.length && methods.length ? 2 : 0);
  if (fields.length && methods.length) cursor += layout.sectionPad;
  const methodSvg = renderLines(methods);
  const passport = {
    kind: type.kind,
    sublabel: packageLabel || stereotype,
    tag: type.stereotype,
    context: `${fields.length} fields · ${methods.length} methods`,
  };
  return `        <g ${focusNodeAttrs(type.id, type.name, passport, diagram.meta.locale)}>
          ${focusNodeTitle(type.name, passport)}
          <rect x="${type.x}" y="${type.y}" width="${type.width}" height="${type.height}" rx="5" class="c-mask"/>
          <rect x="${type.x}" y="${type.y}" width="${type.width}" height="${type.height}" rx="5" class="${fill}"${animateAttr(diagram.meta, 'node', index)} stroke-width="1.5"/>
          ${renderSemanticSigil(tone, { x: type.x + 7, y: type.y + 7 })}
          ${stereotype ? `<text x="${type.cx}" y="${type.y + 15}" class="t-muted" font-size="7" text-anchor="middle">«${esc(stereotype)}»</text>` : ''}
          <text data-node-label="" x="${type.cx}" y="${type.y + 34}" class="t-primary" font-size="11" font-weight="600" text-anchor="middle"${type.kind === 'abstract-class' ? ' font-style="italic"' : ''}>${esc(type.name)}</text>
          ${packageLabel ? `<text data-detail="context" x="${type.cx}" y="${type.y + 47}" class="t-muted" font-size="8" text-anchor="middle">${esc(packageLabel)}</text>` : ''}
          <line x1="${type.x}" y1="${type.y + layout.headerH}" x2="${type.x + type.width}" y2="${type.y + layout.headerH}" class="a-default" stroke-width="0.8"/>
          ${fieldSvg}
          ${fields.length && methods.length ? `<line x1="${type.x}" y1="${methodDividerY}" x2="${type.x + type.width}" y2="${methodDividerY}" class="a-default" stroke-width="0.8"/>` : ''}
          ${methodSvg}
        </g>`;
}

function renderLegend() {
  return renderResolvedLegend({
    entries: legendEntries,
    locale: diagram.meta.locale,
    layout: {
      x: layout.margin,
      baselineY: viewBox[1] - 16,
      width: viewBox[0] - layout.margin * 2,
      minTitleY: maxY + 4,
      unfit: diagram.meta?.legend === undefined ? 'hide' : 'error',
      diagramType: 'class-diagram',
    },
    renderSwatch: (entry) => `<line x1="${entry.x}" y1="${entry.baseline - 4}" x2="${entry.x + 16}" y2="${entry.baseline - 4}" class="${['realization', 'dependency'].includes(entry.kind) ? 'a-dashed' : 'a-default'}" stroke-width="1.5"/>`,
  });
}

function renderSvg() {
  return `      <svg viewBox="0 0 ${viewBox[0]} ${viewBox[1]}" ${svgRootAttrs(diagram.meta)}>
${svgAccessibleText(diagram.meta, 'class-diagram')}
${renderDefinitions()}
        <defs>
          <marker id="uml-inheritance" markerWidth="12" markerHeight="10" refX="11" refY="5" orient="auto"><path d="M1 1 L11 5 L1 9 Z" fill="var(--mask)" stroke="var(--arrow)"/></marker>
          <marker id="uml-realization" markerWidth="12" markerHeight="10" refX="11" refY="5" orient="auto"><path d="M1 1 L11 5 L1 9 Z" fill="var(--mask)" stroke="var(--database-stroke)"/></marker>
          <marker id="uml-aggregation" markerWidth="14" markerHeight="10" refX="1" refY="5" orient="auto"><path d="M1 5 L7 1 L13 5 L7 9 Z" fill="var(--mask)" stroke="var(--arrow)"/></marker>
          <marker id="uml-composition" markerWidth="14" markerHeight="10" refX="1" refY="5" orient="auto"><path d="M1 5 L7 1 L13 5 L7 9 Z" fill="var(--arrow)" stroke="var(--arrow)"/></marker>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)"/>
${(diagram.relationships || []).map(renderRelationship).join('\n')}
${measured.map(renderType).join('\n\n')}
${(diagram.relationships || []).map(renderRelationshipDetail).join('\n')}
${renderLegend()}
      </svg>`.replace(/^[ \t]+$/gm, '');
}

validateClassDiagram();
writeDiagram({
  outPath,
  template,
  diagramType: 'class-diagram',
  meta: diagram.meta,
  svg: renderSvg(),
  cards: diagram.cards,
});
