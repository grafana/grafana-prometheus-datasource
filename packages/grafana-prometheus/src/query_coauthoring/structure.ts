import { type SyntaxNode } from '@lezer/common';
import { parser, QuotedLabelName, StringLiteral } from '@prometheus-io/lezer-promql';

import { ErrorId, replaceBuiltInVariable } from '../querybuilder/parsingUtils';

/** @internal */
export interface TextRange {
  from: number;
  to: number;
}

/** @internal */
export interface EditorSelection {
  anchor: number;
  head: number;
}

/** @internal */
export type ChangeFocus = 'inside' | 'outside' | 'mixed';

/** @internal */
export interface QuerySyntaxAnchor {
  kind: 'aggregation' | 'binary-expression' | 'function' | 'label-matcher' | 'range' | 'selector';
  range: TextRange;
}

/** @internal */
export interface StagedQueryChange {
  id: string;
  originalRange: TextRange;
  proposedRange: TextRange;
  focus: ChangeFocus;
  originalAnchor?: QuerySyntaxAnchor;
  proposedAnchor?: QuerySyntaxAnchor;
}

/** @internal */
export type PromQLValidation = { valid: true } | { valid: false };

/** @internal */
export type StagedQueryDiff = { valid: true; changes: StagedQueryChange[] } | { valid: false; changes: [] };

/** @internal */
export interface StagedQueryDiffOptions {
  originalInterpolatedQuery?: string;
  proposedInterpolatedQuery?: string;
}

interface DiffToken {
  text: string;
}

interface DiffOperation {
  kind: 'equal' | 'delete' | 'insert';
  token: DiffToken;
}

interface RawChange {
  originalRange: TextRange;
  proposedRange: TextRange;
}

const templateVariablePattern = /\$(?:\w+|\{[^}]+\})|\[\[[^\]]+\]\]/;
const diffTokenPattern =
  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\p{L}_:][\p{L}\p{N}_:.]*|\d+(?:\.\d+)?(?:ms|s|m|h|d|w|y)?|\s+|./gu;
const MAX_DIFF_MATRIX_CELLS = 1_000_000;

const anchorKinds: Record<string, QuerySyntaxAnchor['kind']> = {
  AggregateExpr: 'aggregation',
  BinaryExpr: 'binary-expression',
  FunctionCall: 'function',
  MatrixSelector: 'selector',
  NumberDurationLiteralInDurationContext: 'range',
  QuotedLabelMatcher: 'label-matcher',
  UnquotedLabelMatcher: 'label-matcher',
  VectorSelector: 'selector',
};

/** @internal */
export function normalizeFocusRanges(query: string, selections: EditorSelection[]): TextRange[] {
  if (query.length === 0) {
    return [];
  }

  const nonEmptySelections = selections
    .map(({ anchor, head }) => ({
      from: clamp(Math.min(anchor, head), 0, query.length),
      to: clamp(Math.max(anchor, head), 0, query.length),
    }))
    .filter(({ from, to }) => from !== to);

  if (nonEmptySelections.length === 0) {
    return [{ from: 0, to: query.length }];
  }

  const parsedQuery = replaceBuiltInVariable(query);
  const lexicalTokens = collectLexicalTokens(parsedQuery);
  const expanded = nonEmptySelections.map((selection) => {
    const lexicalRange = expandToLexicalBoundaries(selection, lexicalTokens);
    const intersectingTokens = lexicalTokens.filter((token) => token.to > selection.from && token.from < selection.to);
    if (intersectingTokens.length < 2) {
      return lexicalRange;
    }

    return findSyntaxAnchor(parsedQuery, lexicalRange)?.range ?? lexicalRange;
  });
  return mergeRanges(expanded);
}

/** @internal */
export function extractMetricNames(query: string): string[] {
  const names = new Set<string>();

  parser.parse(query).iterate({
    enter: (node) => {
      if (node.name !== 'VectorSelector') {
        return;
      }

      const identifier = node.node.getChild('Identifier');
      if (identifier) {
        names.add(query.slice(identifier.from, identifier.to));
        return false;
      }

      const quotedMetricNode = node.node.getChild('LabelMatchers')?.getChild(QuotedLabelName)?.getChild(StringLiteral);
      if (quotedMetricNode) {
        const metricName = decodePromQLStringLiteral(query.slice(quotedMetricNode.from, quotedMetricNode.to));
        if (metricName !== undefined) {
          names.add(metricName);
        }
        return false;
      }

      const selector = query.slice(node.from, node.to);
      const nameMatcher = /__name__\s*=\s*"((?:\\.|[^"\\])*)"/.exec(selector);
      if (nameMatcher) {
        names.add(nameMatcher[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
      }
      return false;
    },
  });

  return Array.from(names);
}

/** @internal */
export function validatePromQL(query: string, interpolatedQuery = query): PromQLValidation {
  if (query.trim().length === 0) {
    return { valid: false };
  }

  let hasError = false;
  parser.parse(interpolatedQuery).iterate({
    enter: (node) => {
      if (node.type.id === ErrorId) {
        hasError = true;
        return false;
      }
      return;
    },
  });

  return { valid: !hasError };
}

/** @internal */
export function buildStagedQueryDiff(
  originalQuery: string,
  proposedQuery: string,
  focusRanges: TextRange[],
  options: StagedQueryDiffOptions = {}
): StagedQueryDiff {
  if (!validatePromQL(proposedQuery, options.proposedInterpolatedQuery).valid) {
    return { valid: false, changes: [] };
  }

  const normalizedFocus = mergeRanges(
    focusRanges.map(({ from, to }) => ({
      from: clamp(Math.min(from, to), 0, originalQuery.length),
      to: clamp(Math.max(from, to), 0, originalQuery.length),
    }))
  );
  const rawChanges = computeRawChanges(originalQuery, proposedQuery);
  const originalCanAnchor =
    validatePromQL(originalQuery, options.originalInterpolatedQuery).valid &&
    !templateVariablePattern.test(originalQuery);
  const proposedCanAnchor = !templateVariablePattern.test(proposedQuery);

  return {
    valid: true,
    changes: rawChanges.map((change, index) => ({
      id: `change-${index + 1}`,
      ...change,
      focus: classifyFocus(change.originalRange, normalizedFocus),
      ...(originalCanAnchor ? { originalAnchor: findSyntaxAnchor(originalQuery, change.originalRange) } : {}),
      ...(proposedCanAnchor ? { proposedAnchor: findSyntaxAnchor(proposedQuery, change.proposedRange) } : {}),
    })),
  };
}

function collectLexicalTokens(query: string): TextRange[] {
  const tokens: TextRange[] = [];

  parser.parse(query).iterate({
    enter: (node) => {
      if (node.type.id !== ErrorId && node.from < node.to && !node.node.firstChild) {
        tokens.push({ from: node.from, to: node.to });
      }
    },
  });

  return tokens.sort((left, right) => left.from - right.from || left.to - right.to);
}

function expandToLexicalBoundaries(selection: TextRange, tokens: TextRange[]): TextRange {
  const intersecting = tokens.filter((token) => token.to > selection.from && token.from < selection.to);
  if (intersecting.length > 0) {
    return {
      from: Math.min(selection.from, intersecting[0].from),
      to: Math.max(selection.to, intersecting[intersecting.length - 1].to),
    };
  }

  const previous = findLast(tokens, (token) => token.to <= selection.from);
  const next = tokens.find((token) => token.from >= selection.to);

  if (previous && next) {
    return { from: previous.from, to: next.to };
  }
  return previous ?? next ?? selection;
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = ranges
    .filter(({ from, to }) => from <= to)
    .slice()
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: TextRange[] = [];

  for (const current of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || current.from > previous.to) {
      merged.push({ ...current });
      continue;
    }
    previous.to = Math.max(previous.to, current.to);
  }

  return merged;
}

function computeRawChanges(originalQuery: string, proposedQuery: string): RawChange[] {
  if (originalQuery === proposedQuery) {
    return [];
  }

  const originalTokens = tokenizeDiff(originalQuery);
  const proposedTokens = tokenizeDiff(proposedQuery);

  if ((originalTokens.length + 1) * (proposedTokens.length + 1) > MAX_DIFF_MATRIX_CELLS) {
    return [
      {
        originalRange: { from: 0, to: originalQuery.length },
        proposedRange: { from: 0, to: proposedQuery.length },
      },
    ];
  }

  const operations = diffTokens(originalTokens, proposedTokens);
  const changes: RawChange[] = [];
  let originalOffset = 0;
  let proposedOffset = 0;
  let active: RawChange | undefined;

  const finishActiveChange = () => {
    if (active) {
      changes.push(active);
      active = undefined;
    }
  };

  for (const operation of operations) {
    if (operation.kind === 'equal') {
      finishActiveChange();
      originalOffset += operation.token.text.length;
      proposedOffset += operation.token.text.length;
      continue;
    }

    active ??= {
      originalRange: { from: originalOffset, to: originalOffset },
      proposedRange: { from: proposedOffset, to: proposedOffset },
    };

    if (operation.kind === 'delete') {
      originalOffset += operation.token.text.length;
      active.originalRange.to = originalOffset;
    } else {
      proposedOffset += operation.token.text.length;
      active.proposedRange.to = proposedOffset;
    }
  }
  finishActiveChange();

  return changes;
}

function decodePromQLStringLiteral(literal: string): string | undefined {
  if (literal.length < 2 || literal[0] !== literal[literal.length - 1]) {
    return undefined;
  }

  const quote = literal[0];
  const value = literal.slice(1, -1);
  if (quote === '`') {
    return value;
  }
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }

  let decoded = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '\\') {
      decoded += value[index];
      continue;
    }

    const escape = value[++index];
    const simpleEscapes: Record<string, string> = {
      a: '\x07',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      '"': '"',
      "'": "'",
    };
    if (escape in simpleEscapes) {
      decoded += simpleEscapes[escape];
      continue;
    }

    const digits = escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : /^[0-7]$/.test(escape) ? 3 : 0;
    const radix = /^[0-7]$/.test(escape) ? 8 : 16;
    const encoded =
      radix === 8 ? escape + value.slice(index + 1, index + digits) : value.slice(index + 1, index + 1 + digits);
    if (
      digits === 0 ||
      encoded.length !== digits ||
      !new RegExp(`^[0-${radix === 8 ? '7' : '9a-fA-F'}]+$`).test(encoded)
    ) {
      return undefined;
    }

    const codePoint = Number.parseInt(encoded, radix);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return undefined;
    }
    decoded += String.fromCodePoint(codePoint);
    index += radix === 8 ? digits - 1 : digits;
  }

  return decoded;
}

function tokenizeDiff(value: string): DiffToken[] {
  return Array.from(value.matchAll(diffTokenPattern), (match) => ({
    text: match[0],
  }));
}

function diffTokens(original: DiffToken[], proposed: DiffToken[]): DiffOperation[] {
  const width = proposed.length + 1;
  const lengths = new Uint32Array((original.length + 1) * width);

  for (let originalIndex = original.length - 1; originalIndex >= 0; originalIndex--) {
    for (let proposedIndex = proposed.length - 1; proposedIndex >= 0; proposedIndex--) {
      const index = originalIndex * width + proposedIndex;
      lengths[index] =
        original[originalIndex].text === proposed[proposedIndex].text
          ? lengths[(originalIndex + 1) * width + proposedIndex + 1] + 1
          : Math.max(lengths[(originalIndex + 1) * width + proposedIndex], lengths[index + 1]);
    }
  }

  const operations: DiffOperation[] = [];
  let originalIndex = 0;
  let proposedIndex = 0;

  while (originalIndex < original.length && proposedIndex < proposed.length) {
    if (original[originalIndex].text === proposed[proposedIndex].text) {
      operations.push({ kind: 'equal', token: original[originalIndex] });
      originalIndex++;
      proposedIndex++;
    } else if (
      lengths[(originalIndex + 1) * width + proposedIndex] >= lengths[originalIndex * width + proposedIndex + 1]
    ) {
      operations.push({ kind: 'delete', token: original[originalIndex++] });
    } else {
      operations.push({ kind: 'insert', token: proposed[proposedIndex++] });
    }
  }

  while (originalIndex < original.length) {
    operations.push({ kind: 'delete', token: original[originalIndex++] });
  }
  while (proposedIndex < proposed.length) {
    operations.push({ kind: 'insert', token: proposed[proposedIndex++] });
  }

  return operations;
}

function classifyFocus(change: TextRange, focusRanges: TextRange[]): ChangeFocus {
  if (change.from === change.to) {
    return focusRanges.some((focus) => focus.from <= change.from && change.from <= focus.to) ? 'inside' : 'outside';
  }

  const covered = focusRanges.reduce((total, focus) => {
    return total + Math.max(0, Math.min(change.to, focus.to) - Math.max(change.from, focus.from));
  }, 0);

  if (covered === 0) {
    return 'outside';
  }
  return covered >= change.to - change.from ? 'inside' : 'mixed';
}

function findSyntaxAnchor(query: string, change: TextRange): QuerySyntaxAnchor | undefined {
  let best: SyntaxNode | undefined;

  parser.parse(query).iterate({
    enter: (node) => {
      if (!anchorKinds[node.name] || !containsRange(node.node, change)) {
        return;
      }

      if (!best || node.to - node.from < best.to - best.from) {
        best = node.node;
      }
    },
  });

  if (!best) {
    return undefined;
  }

  return {
    kind: anchorKinds[best.name],
    range: { from: best.from, to: best.to },
  };
}

function containsRange(node: SyntaxNode, range: TextRange): boolean {
  if (range.from === range.to) {
    return node.from <= range.from && range.from <= node.to;
  }
  return node.from <= range.from && range.to <= node.to;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) {
      return items[index];
    }
  }
  return undefined;
}
