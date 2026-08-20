import { type DataQuery } from '@grafana/data';

// This temporary internal type-only compatibility surface is removed when released @grafana/data packages include Core's alpha API.

export interface QueryEditorCoauthoringRangeV1 {
  from: number;
  to: number;
}

export interface QueryEditorCoauthoringMetricMetadataV1 {
  name: string;
  type?: string;
  help?: string;
  unit?: string;
  labels?: string[];
}

export interface QueryEditorCoauthoringContextV1 {
  revision: string;
  query: string;
  focusRanges: QueryEditorCoauthoringRangeV1[];
  language: { id: string; displayName: string };
  metricMetadata: QueryEditorCoauthoringMetricMetadataV1[];
}

export interface QueryEditorCoauthoringChangeV1 {
  id: string;
  original: string;
  proposed: string;
  kind?: string;
  focus?: 'inside' | 'outside' | 'mixed';
}

export type QueryEditorCoauthoringSnapshotV1 =
  | { mode: 'hidden' }
  | { mode: 'selection'; selectedText: string; revision: string }
  | { mode: 'session'; revision: string };

export interface QueryEditorCoauthoringControllerV1<TQuery extends DataQuery = DataQuery> {
  getSnapshot(): QueryEditorCoauthoringSnapshotV1;
  subscribe(listener: VoidFunction): VoidFunction;
  getPortalTarget(): HTMLElement;
  reportSurfaceSize(size: { height: number; width: number }): void;
  begin(): Promise<QueryEditorCoauthoringContextV1>;
  refreshContext(): Promise<QueryEditorCoauthoringContextV1>;
  getQueryText(): string;
  stageEditorDiff(source: string):
    | {
        status: 'staged';
        query: TQuery;
        changes: QueryEditorCoauthoringChangeV1[];
      }
    | { status: 'rejected'; reason: 'invalid' | 'unchanged' | 'stale' };
  clearEditorDiff(): void;
  focus(): void;
  dismiss(): void;
}

export interface QueryEditorCoauthoringV1Props {
  createController(): QueryEditorCoauthoringControllerV1;
}
