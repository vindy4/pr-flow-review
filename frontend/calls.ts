import type { CallEdge, Symbol, View } from './types';

export function callSide(edge: CallEdge, view: View): 'base' | 'head' {
  if (view === 'base' && edge.inBase) return 'base';
  if (view === 'head' && edge.inHead) return 'head';
  return edge.inHead ? 'head' : 'base';
}

export function callExpression(edge: CallEdge, side: 'base' | 'head', source?: Symbol): string {
  const expression = side === 'base' ? edge.baseExpression : edge.headExpression;
  if (expression) return expression;
  const version = side === 'base' ? source?.base : source?.head;
  const line = side === 'base' ? edge.baseLine : edge.headLine;
  return (version && line != null ? version.code.split('\n')[line - version.startLine]?.trim() : undefined) || edge.expression;
}

export function relationLabel(edge: CallEdge) {
  return edge.relation === 'render' ? 'Renders' : edge.relation === 'callback' ? 'Callback reference' : 'Calls';
}
