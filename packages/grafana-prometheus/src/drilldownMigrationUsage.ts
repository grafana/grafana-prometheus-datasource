import { type SyntaxNode, type Tree } from '@lezer/common';
import {
  AggregateModifier,
  By,
  GroupingLabels,
  Identifier,
  LabelName,
  MatchOp,
  parser,
  QuotedLabelMatcher,
  QuotedLabelName,
  StringLiteral,
  UnquotedLabelMatcher,
} from '@prometheus-io/lezer-promql';

import { type PromQuery } from './types';

/**
 * Backs `PrometheusDatasource.getDrilldownMigrationUsage` (see datasource.ts). Relocated from
 * the unmerged grafana-core branch `spec/prometheus-query-var-migration`
 * (`variable-migration/promqlVariableUsage.ts`) - only the classification half; that branch's
 * `removeVariableUsagesFromExpr` (deterministic expr rewriting) is intentionally not ported,
 * since this capability only classifies usage for the Assistant, it never mutates queries
 * itself (see the variable-migration-assistant-cta spec's Non-goals).
 *
 * The variable-placeholder machinery (variableRegex/replaceVariables/built-ins) is a smaller,
 * classification-only copy of `querybuilder/parsingUtils.ts`'s version in this same package:
 * that version returns a replacement map and omits `$__auto` (not in its BUILT_IN_VARIABLES),
 * and its `returnVariables`/`returnBuiltInVariable` aren't needed here since classification
 * never has to restore the original text.
 */

/*
 * Matches 3 variable interpolation syntaxes with an optional format specifier:
 * \$(\w+)                          $var1
 * \[\[([\s\S]+?)(?::(\w+))?\]\]    [[var2]] or [[var2:fmt2]]
 * \${(\w+)(?:\.(...))?(?::(...))?} ${var3}, ${var3.field}, ${var3:fmt3}
 */
const variableRegex = /\$(\w+)|\[\[([\s\S]+?)(?::(\w+))?\]\]|\${(\w+)(?:\.([^:^}]+))?(?::([^}]+))?}/g;

function replaceVariables(expr: string): string {
  return expr.replace(variableRegex, (match, var1, var2, fmt2, var3, _fieldPath, fmt3) => {
    const fmt = fmt2 || fmt3;
    let variable = var1;
    let varType = '0';

    if (var2) {
      variable = var2;
      varType = '1';
    }
    if (var3) {
      variable = var3;
      varType = '2';
    }

    return `__V_${varType}__` + variable + '__V__' + (fmt ? '__F__' + fmt + '__F__' : '');
  });
}

/**
 * `${var.field}` field-path references and format specifiers with non-word characters both
 * survive `replaceVariables` in a way that loses information (the field path is dropped
 * entirely; only word-shaped formats are re-encoded) - classifying an occurrence like that as
 * an ordinary filter/groupBy usage would be misleading, so callers treat either as disqualifying.
 */
function hasUnsupportedVariableSyntax(expr: string): boolean {
  for (const match of expr.matchAll(variableRegex)) {
    const fieldPath = match[5];
    const format = match[3] ?? match[6];
    if (fieldPath !== undefined || (format !== undefined && /\W/.test(format))) {
      return true;
    }
  }
  return false;
}

// Duration/range positions require a numeric literal, so `$var`-style placeholders (which
// parse as identifiers) don't work there - these get dedicated numeric replacements instead.
// $__auto is included because Scenes can inject it as a query interval; every other value
// mirrors this package's own querybuilder/parsingUtils.ts BUILT_IN_VARIABLES list.
const BUILT_IN_VARIABLES: Array<{ variable: string; replacement: string }> = [
  { variable: '$__interval_ms', replacement: '79_999_999_999' },
  { variable: '$__interval', replacement: '711_999_999' },
  { variable: '$__rate_interval', replacement: '7999799979997999' },
  { variable: '$__range_ms', replacement: '722_999_999' },
  { variable: '$__range_s', replacement: '79_299_999' },
  { variable: '$__range', replacement: '799_999' },
  { variable: '$__auto', replacement: '7_99_999' },
];

const builtInVariableRegex = new RegExp(
  BUILT_IN_VARIABLES.map(({ variable }) => variable.replace(/\$/g, '\\$')).join('|'),
  'g'
);

const stringLiteralRegex = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g;

/**
 * Replaces variables other than `variableName` that sit in numeric-only positions (range /
 * subquery brackets, `offset`, `@`) with a numeric literal, so that e.g. a custom `$window`
 * interval variable doesn't turn the whole expression into a parse error and hide an otherwise
 * clean usage of `variableName`. The variable being classified is left alone: if it's in one of
 * these positions, the resulting parse error correctly makes it unsafe.
 */
function replaceNumericPositionVariables(expr: string, variableName: string): string {
  const stringSpans = [...expr.matchAll(stringLiteralRegex)].map((m) => [m.index, m.index + m[0].length]);

  return expr.replace(variableRegex, (match, var1, var2, _fmt2, var3, _fieldPath, _fmt3, offset: number) => {
    const name = var1 ?? var2 ?? var3;
    if (name === variableName || stringSpans.some(([from, to]) => offset >= from && offset < to)) {
      return match;
    }

    // Every string literal before `offset` is complete, so stripping them leaves only real brackets.
    const before = expr.slice(0, offset).replace(stringLiteralRegex, '');
    const bracketDepth = (before.match(/\[/g)?.length ?? 0) - (before.match(/\]/g)?.length ?? 0);

    if (bracketDepth > 0 || /(?:\boffset|@)\s*-?\s*$/i.test(before)) {
      return '1';
    }
    return match;
  });
}

function replaceBuiltInVariables(expr: string): string {
  return expr.replace(builtInVariableRegex, (match) => {
    return BUILT_IN_VARIABLES.find((v) => v.variable === match)?.replacement ?? match;
  });
}

/**
 * True when `text` interpolates the named variable in any of the three syntaxes, regardless
 * of whether the expression parses. Cheap pre-check so callers can skip parsing entirely when
 * a query doesn't reference the variable at all.
 */
function textReferencesVariable(text: string, variableName: string): boolean {
  for (const match of text.matchAll(variableRegex)) {
    const name = match[1] ?? match[2] ?? match[4];
    if (name === variableName) {
      return true;
    }
  }
  return false;
}

type PromQLVariableUsage =
  | { position: 'filterValue'; labelKey: string; operator: string }
  | { position: 'groupByLabel' }
  | { position: 'other'; context: string };

const placeholderPattern = /__V_[0-2]__(\w+?)__V__(?:__F__.+?__F__)?/;

function buildOccurrenceRegex(variableName: string): RegExp {
  return new RegExp(`__V_[0-2]__${variableName}__V__(?:__F__.+?__F__)?`, 'g');
}

function treeHasError(tree: Tree): boolean {
  let hasError = false;
  tree.iterate({
    enter: (node) => {
      if (node.type.isError) {
        hasError = true;
        return false;
      }
      return;
    },
  });
  return hasError;
}

/**
 * Classifies every occurrence of `variableName` in a PromQL expression by structural position
 * (lezer parse, no regex guessing): the value of a label matcher (`{key=~"$var"}`) on a
 * selector with a metric name -> `filterValue`; a grouping label in a `by(...)` aggregation
 * modifier -> `groupByLabel`; anything else (metric name, function arg, `without(...)`,
 * partial matcher value, on/ignoring, ...) -> `other`. All four matcher operators
 * (`=`, `!=`, `=~`, `!~`) map to ad hoc filter operators, so none of them disqualifies.
 */
function classifyVariableUsagesInExpr(
  expr: string,
  variableName: string
): { usages: PromQLVariableUsage[]; hasParseError: boolean } {
  const replacedExpr = replaceVariables(replaceNumericPositionVariables(replaceBuiltInVariables(expr), variableName));
  const tree = parser.parse(replacedExpr);

  const usages: PromQLVariableUsage[] = [];
  for (const match of replacedExpr.matchAll(buildOccurrenceRegex(variableName))) {
    usages.push(classifyOccurrence(tree, replacedExpr, match.index, match.index + match[0].length));
  }

  return { usages, hasParseError: treeHasError(tree) };
}

function classifyOccurrence(tree: Tree, expr: string, from: number, to: number): PromQLVariableUsage {
  const node = tree.resolveInner(from, 1);

  if (node.type.id === StringLiteral) {
    return classifyStringLiteralOccurrence(node, expr, from, to);
  }

  if (node.type.id === LabelName && node.parent?.type.id === GroupingLabels) {
    return classifyGroupingLabelOccurrence(node, from, to);
  }

  return { position: 'other', context: nodeContext(node) };
}

function classifyStringLiteralOccurrence(
  stringNode: SyntaxNode,
  expr: string,
  from: number,
  to: number
): PromQLVariableUsage {
  const matcher = stringNode.parent;
  if (!matcher || (matcher.type.id !== UnquotedLabelMatcher && matcher.type.id !== QuotedLabelMatcher)) {
    return { position: 'other', context: nodeContext(stringNode) };
  }

  // The variable must be the entire matcher value (only the quotes around it).
  if (from !== stringNode.from + 1 || to !== stringNode.to - 1) {
    return { position: 'other', context: 'partial label matcher value' };
  }

  const labelKey = getMatcherLabelKey(matcher, expr);
  if (labelKey === undefined || placeholderPattern.test(labelKey)) {
    return { position: 'other', context: 'variable label matcher key' };
  }

  const opNode = matcher.getChild(MatchOp);
  if (!opNode) {
    return { position: 'other', context: 'label matcher without operator' };
  }
  const operator = expr.substring(opNode.from, opNode.to);

  // Removing the matcher must not leave an empty selector (`{}` is invalid PromQL), so the
  // selector needs a metric name or at least one other matcher.
  if (!selectorHasOtherContent(matcher)) {
    return { position: 'other', context: 'only matcher in a selector without metric name' };
  }

  return { position: 'filterValue', labelKey, operator };
}

function selectorHasOtherContent(matcher: SyntaxNode): boolean {
  const labelMatchers = matcher.parent;
  if (!labelMatchers) {
    return false;
  }
  if (labelMatchers.getChild(QuotedLabelName) || labelMatchers.parent?.getChild(Identifier) != null) {
    return true;
  }
  const matchers = [
    ...labelMatchers.getChildren(UnquotedLabelMatcher),
    ...labelMatchers.getChildren(QuotedLabelMatcher),
  ];
  return matchers.length > 1;
}

function getMatcherLabelKey(matcher: SyntaxNode, expr: string): string | undefined {
  const labelNode = matcher.getChild(LabelName) ?? matcher.getChild(QuotedLabelName);
  if (!labelNode) {
    return undefined;
  }
  const text = expr.substring(labelNode.from, labelNode.to);
  return labelNode.type.id === QuotedLabelName ? text.slice(1, -1) : text;
}

function classifyGroupingLabelOccurrence(labelNode: SyntaxNode, from: number, to: number): PromQLVariableUsage {
  if (labelNode.from !== from || labelNode.to !== to) {
    return { position: 'other', context: 'partial grouping label' };
  }

  const groupingParent = labelNode.parent?.parent;
  if (groupingParent?.type.id !== AggregateModifier) {
    // on(...) / ignoring(...) / group_left(...) grouping labels of binary expressions
    return { position: 'other', context: nodeContext(labelNode) };
  }

  if (!groupingParent.getChild(By)) {
    return { position: 'other', context: 'without() grouping' };
  }

  return { position: 'groupByLabel' };
}

function nodeContext(node: SyntaxNode): string {
  return node.parent ? `${node.parent.name} > ${node.name}` : node.name;
}

function isFilterValueUsage(
  usage: PromQLVariableUsage
): usage is Extract<PromQLVariableUsage, { position: 'filterValue' }> {
  return usage.position === 'filterValue';
}

/**
 * @alpha
 * Local mirror of `@grafana/data`'s `DrilldownMigrationUsage` (added in the grafana repo, not
 * yet released to the `@grafana/data` version this package depends on - see the Worklog entry
 * for the cross-repo step in the variable-migration-assistant-cta spec). Once that capability
 * ships in a released `@grafana/data` and this package's dependency on it is bumped, this type
 * (and `DrilldownMigrationUsageOptions` below) should be deleted in favor of importing it.
 */
export type DrilldownMigrationUsage =
  | { kind: 'filter'; key: string; operator: string }
  | { kind: 'groupBy' }
  | { kind: 'unsafe'; reason?: string };

/**
 * @alpha
 * Local mirror of `@grafana/data`'s `DataSourceGetDrilldownMigrationUsageOptions<PromQuery>` -
 * see the `DrilldownMigrationUsage` doc comment above for why this is a temporary local copy.
 */
export interface DrilldownMigrationUsageOptions {
  variableName: string;
  query: PromQuery;
}

/**
 * Classifies how `variableName` is used within a single PromQL expression, collapsed to the
 * single result the `getDrilldownMigrationUsage` capability contract returns per (variable,
 * query) call:
 * - not referenced in `expr` at all -> `undefined` (nothing to report for this query);
 * - every occurrence agrees on exactly one shape (all `groupByLabel`, or all `filterValue`
 *   with the same label key) -> that shape;
 * - occurrences disagree (e.g. used as both a filter matcher and a `by(...)` grouping label,
 *   or the same variable filters on two different label keys, within this one expression) ->
 *   `unsafe`. The capability can only return one classification per call, and reporting only
 *   one of several conflicting usages would hide the other from the caller's aggregation, so
 *   any internal disagreement is conservatively treated the same as an actually-unsafe usage;
 * - a parse error, unsupported variable syntax (field path / non-word format specifier
 *   anywhere in the expression), or any occurrence in an unsafe position -> `unsafe`.
 */
export function classifyDrilldownMigrationUsage(
  variableName: string,
  expr: string
): DrilldownMigrationUsage | undefined {
  if (!textReferencesVariable(expr, variableName)) {
    return undefined;
  }

  if (hasUnsupportedVariableSyntax(expr)) {
    return { kind: 'unsafe', reason: 'query uses an unsupported variable syntax (field path or format specifier)' };
  }

  const { usages, hasParseError } = classifyVariableUsagesInExpr(expr, variableName);

  if (hasParseError) {
    return { kind: 'unsafe', reason: 'could not parse the query expression' };
  }

  if (usages.length === 0) {
    // Defensive only: textReferencesVariable's regex and classifyVariableUsagesInExpr's
    // occurrence scan both key off the same variable name, so this shouldn't be reachable.
    return { kind: 'unsafe', reason: 'could not classify how the variable is used in this query' };
  }

  if (usages.some((usage) => usage.position === 'other')) {
    return { kind: 'unsafe', reason: 'variable is used in a position that cannot be migrated' };
  }

  const positions = new Set(usages.map((usage) => usage.position));
  if (positions.size > 1) {
    return { kind: 'unsafe', reason: 'variable is used in more than one way within this query' };
  }

  if (positions.has('groupByLabel')) {
    return { kind: 'groupBy' };
  }

  const filterUsages = usages.filter(isFilterValueUsage);
  const labelKeys = new Set(filterUsages.map((usage) => usage.labelKey));
  if (labelKeys.size > 1) {
    return { kind: 'unsafe', reason: 'variable filters on more than one label key within this query' };
  }

  // Multiple occurrences that agree on the label key may still use different operators (e.g.
  // one "=" and one "=~") - the generic caller only disqualifies on disagreeing keys, not
  // operators, so reporting the first occurrence's operator is a reasonable simplification
  // rather than a third disqualifying rule this capability's contract doesn't ask for.
  return { kind: 'filter', key: filterUsages[0].labelKey, operator: filterUsages[0].operator };
}

/**
 * Backs `PrometheusDatasource.getDrilldownMigrationUsage` (datasource.ts), which just forwards
 * its options here. Kept as a plain function, not inlined on the class, so it's directly
 * unit-testable without constructing a datasource instance.
 */
export function classifyDrilldownMigrationUsageForQuery(
  options: DrilldownMigrationUsageOptions
): DrilldownMigrationUsage | undefined {
  const { query, variableName } = options;

  // Only `expr` is parsed, but the variable may also drive other query fields (legendFormat,
  // interval, ...) - migrating it away would silently break those, so treat that as unsafe.
  const usedOutsideExpr = Object.entries(query).some(
    ([key, value]) =>
      key !== 'expr' && key !== 'refId' && typeof value === 'string' && textReferencesVariable(value, variableName)
  );
  if (usedOutsideExpr) {
    return { kind: 'unsafe', reason: 'variable is used in a query field other than the expression' };
  }

  if (!query.expr) {
    return undefined;
  }
  return classifyDrilldownMigrationUsage(variableName, query.expr);
}
