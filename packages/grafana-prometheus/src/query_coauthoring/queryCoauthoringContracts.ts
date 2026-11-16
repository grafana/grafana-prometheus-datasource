import { type DataQuery } from '@grafana/schema';

/**
 * Private structural copies used by Prometheus for Query Coauthoring v2.
 * Source: grafana/grafana, public/app/features/dashboard-scene/panel-edit/PanelEditNext/
 * QueryEditor/coauthoring/queryCoauthoringContracts.ts
 * Reference: a2bd0ed280428d8ef5a4d9bd24729b510e6f246b (PR #137907, language support addition).
 * Coordinate mirrored changes or bump the contract version. Remove these copies once
 * this repository pins a Grafana release containing the promoted language/editor contracts.
 * Do not add these contracts to published DataSourceApi or QueryEditorProps interfaces.
 */
/** Offsets in query text, with an exclusive end. */
export interface QueryCoauthoringRange {
  from: number;
  to: number;
}

export interface QueryCoauthoringLanguageDescription {
  text: string;
  language: { id: string; displayName: string; guidance?: string[] };
  metadata?: Array<{ kind: string; name: string; attributes?: Record<string, string | string[]> }>;
}

export interface QueryCoauthoringTextChange {
  original: string;
  proposed: string;
  originalRanges: QueryCoauthoringRange[];
  proposedRanges: QueryCoauthoringRange[];
}

export type QueryCoauthoringPrepareResult<TQuery extends DataQuery = DataQuery> =
  | { status: 'ready'; query: TQuery; changes: QueryCoauthoringTextChange[] }
  | { status: 'rejected'; reason: 'invalid' | 'unchanged' };

export interface QueryCoauthoringLanguage<TQuery extends DataQuery = DataQuery> {
  readonly version: 1;
  /** Synchronous, nonmutating editability check. Absence means unknown, not editable. */
  getQuerySupport?(query: TQuery): { editable: boolean };
  describe(query: TQuery, options: { signal?: AbortSignal }): Promise<QueryCoauthoringLanguageDescription>;
  prepare(baseline: TQuery, text: string): QueryCoauthoringPrepareResult<TQuery>;
}

export interface QueryCoauthoringEditorSelection {
  ranges: QueryCoauthoringRange[];
  anchor: HTMLElement;
}

export interface QueryCoauthoringEditorHandle {
  readonly version: 1;
  getSelection(): QueryCoauthoringEditorSelection | null;
  subscribe(listener: () => void): () => void;
  showChanges?(changes: QueryCoauthoringTextChange[] | null): void;
}

export interface QueryCoauthoringEditorHost {
  readonly version: 1;
  register(handle: QueryCoauthoringEditorHandle): () => void;
  /** Called by the editor for the coauthoring shortcut, including when no text is selected. */
  invoke(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isQueryCoauthoringEditorHost(value: unknown): value is QueryCoauthoringEditorHost {
  return (
    isRecord(value) && value.version === 1 && typeof value.register === 'function' && typeof value.invoke === 'function'
  );
}
