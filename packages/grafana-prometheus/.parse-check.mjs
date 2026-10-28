import { parser, AggregateExpr } from '@prometheus-io/lezer-promql';
console.log('AggregateExpr id', AggregateExpr);
for (const q of ['sum by (g) (up)', 'sum(up) by (g)', 'max(sum by (g) (up))', 'topk(3, sum by (g) (up))', 'count_values("v", up)']) {
  const out = [];
  parser.parse(q).iterate({ enter: (n) => { if (['AggregateExpr','AggregateModifier','GroupingLabels','LabelName'].includes(n.type.name)) out.push(`${n.type.name}@${n.from}-${n.to}(parent=${n.node.parent?.type.name})`); } });
  console.log(q, '=>', out.join(' '));
}
