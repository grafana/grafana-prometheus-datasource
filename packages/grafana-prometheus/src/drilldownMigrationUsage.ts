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
 * Backs `PrometheusDatasource.getDrilldownMigrationUsage` (see datasource.ts). It only classifies
 * how a variable is used so Grafana can decide whether to suggest migrating it to filters; it never
 * rewrites queries, that's left to the Assistant.
 *
 * The query is interpolated the way it is when sent, with the classified variable set to a
 * sentinel, and the sentinel's positions in the parsed PromQL decide the classification. Real
 * interpolation means every variable syntax and format, global macros, and other variables in
 * numeric positions (`[$window]`) behave exactly as in a real request.
 */

/**
 * Interpolates `text` with the classified variable set to `value`, and every other variable,
 * macro, and backend-interpolated interval placeholder to what a request would use.
 */
export type InterpolateWithVariable = (text: string, value: string) => string;

// Valid as a label name (for `by(...)`) and untouched by Prometheus value escaping. Two of them, so
// whether the variable is referenced at all is a comparison rather than a syntax match.
const SENTINEL = 'grafana_drilldown_sentinel_a';
const OTHER_SENTINEL = 'grafana_drilldown_sentinel_b';

/**
 * @alpha
 * Local mirror of `@grafana/data`'s `DrilldownMigrationUsage`, which isn't in a released
 * `@grafana/data` version this package depends on yet. Once it is and the dependency is bumped,
 * delete this type (and `DrilldownMigrationUsageOptions` below) in favor of importing it.
 */
export type DrilldownMigrationUsage =
  | { kind: 'filter'; key: string; operator: string }
  | { kind: 'groupBy' }
  | { kind: 'unsafe'; reason?: string };

/**
 * @alpha
 * Local mirror of `@grafana/data`'s `DataSourceGetDrilldownMigrationUsageOptions<PromQuery>`, see
 * `DrilldownMigrationUsage` above.
 */
export interface DrilldownMigrationUsageOptions {
  variableName: string;
  query: PromQuery;
}

type Position = { kind: 'filter'; key: string; operator: string } | { kind: 'groupBy' } | { kind: 'other' };

const unsafe = (reason: string): DrilldownMigrationUsage => ({ kind: 'unsafe', reason });

/**
 * Classifies how one variable is used in one query, collapsed to the single result the capability
 * returns per (variable, query):
 * - not referenced anywhere in the query -> `undefined`;
 * - referenced from a field other than `expr` (legendFormat, interval, ...) -> `unsafe`, since
 *   migrating the variable away would silently change that field;
 * - every occurrence in `expr` is a whole label-matcher value on the same key -> `filter`, or every
 *   occurrence is a `by(...)` label -> `groupBy`;
 * - anything else (other positions, mixed shapes, two keys, a format that changes the value, an
 *   unparsable expression) -> `unsafe`. Reporting only one of several conflicting usages would hide
 *   the rest from the caller, so any disagreement within the query counts as unsafe.
 */
export function classifyDrilldownMigrationUsage(
  query: PromQuery,
  interpolate: InterpolateWithVariable
): DrilldownMigrationUsage | undefined {
  const references = (text: string) => interpolate(text, SENTINEL) !== interpolate(text, OTHER_SENTINEL);

  const usedOutsideExpr = Object.entries(query).some(
    ([key, value]) => key !== 'expr' && key !== 'refId' && typeof value === 'string' && references(value)
  );
  if (usedOutsideExpr) {
    return unsafe('variable is used in a query field other than the expression');
  }

  if (!query.expr || !references(query.expr)) {
    return undefined;
  }

  const expr = interpolate(query.expr, SENTINEL);
  const offsets = occurrences(expr, SENTINEL);
  if (offsets.length === 0) {
    // Referenced, but a format or field path turned the value into something else.
    return unsafe('variable is used with a format that changes its value');
  }

  const tree = parser.parse(expr);
  if (treeHasError(tree)) {
    return unsafe('could not parse the query expression');
  }

  const positions = offsets.map((from) => classifyOccurrence(tree, expr, from, from + SENTINEL.length));
  if (positions.some((p) => p.kind === 'other')) {
    return unsafe('variable is used in a position that cannot be migrated');
  }
  if (new Set(positions.map((p) => p.kind)).size > 1) {
    return unsafe('variable is used in more than one way within this query');
  }

  const filters = positions.filter((p): p is Extract<Position, { kind: 'filter' }> => p.kind === 'filter');
  if (filters.length === 0) {
    return { kind: 'groupBy' };
  }
  if (new Set(filters.map((f) => f.key)).size > 1) {
    return unsafe('variable filters on more than one label key within this query');
  }

  // Occurrences agreeing on the key may still differ in operator (one "=", one "=~"). The caller only
  // disqualifies on disagreeing keys, so the first operator is reported rather than adding a rule.
  return { kind: 'filter', key: filters[0].key, operator: filters[0].operator };
}

function occurrences(text: string, needle: string): number[] {
  const offsets: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
    offsets.push(i);
  }
  return offsets;
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
 * Where one sentinel occurrence sits: the whole value of a label matcher -> `filter`; a label in a
 * `by(...)` aggregation modifier -> `groupBy`; anything else (metric name, label name, function
 * argument, `without(...)`, `on(...)`, part of a larger value) -> `other`. All four matcher
 * operators (`=`, `!=`, `=~`, `!~`) map to filter operators.
 */
function classifyOccurrence(tree: Tree, expr: string, from: number, to: number): Position {
  const node = tree.resolveInner(from, 1);

  if (node.type.id === StringLiteral) {
    return classifyMatcherValue(node, expr, from, to);
  }

  if (node.type.id === LabelName && node.parent?.type.id === GroupingLabels) {
    const modifier = node.parent.parent;
    const isWholeLabel = node.from === from && node.to === to;
    return isWholeLabel && modifier?.type.id === AggregateModifier && modifier.getChild(By)
      ? { kind: 'groupBy' }
      : { kind: 'other' };
  }

  return { kind: 'other' };
}

function classifyMatcherValue(stringNode: SyntaxNode, expr: string, from: number, to: number): Position {
  const matcher = stringNode.parent;
  if (!matcher || (matcher.type.id !== UnquotedLabelMatcher && matcher.type.id !== QuotedLabelMatcher)) {
    return { kind: 'other' };
  }

  // The variable must be the entire value: only the quotes around it.
  if (from !== stringNode.from + 1 || to !== stringNode.to - 1) {
    return { kind: 'other' };
  }

  const labelNode = matcher.getChild(LabelName) ?? matcher.getChild(QuotedLabelName);
  const opNode = matcher.getChild(MatchOp);
  if (!labelNode || !opNode || !selectorKeepsContent(matcher)) {
    return { kind: 'other' };
  }

  const label = expr.substring(labelNode.from, labelNode.to);
  return {
    kind: 'filter',
    key: labelNode.type.id === QuotedLabelName ? label.slice(1, -1) : label,
    operator: expr.substring(opNode.from, opNode.to),
  };
}

// Removing the matcher must not leave an empty selector (`{}` is invalid PromQL), so the selector
// needs a metric name or at least one other matcher.
function selectorKeepsContent(matcher: SyntaxNode): boolean {
  const labelMatchers = matcher.parent;
  if (!labelMatchers) {
    return false;
  }
  if (labelMatchers.getChild(QuotedLabelName) || labelMatchers.parent?.getChild(Identifier) != null) {
    return true;
  }
  return (
    labelMatchers.getChildren(UnquotedLabelMatcher).length + labelMatchers.getChildren(QuotedLabelMatcher).length > 1
  );
}
