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
  queryKey: string;
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
  focus?: 'inside' | 'outside';
}

export type QueryEditorCoauthoringSnapshotV1 =
  | { mode: 'hidden' }
  | { mode: 'selection'; selectedText: string; revision: string }
  | { mode: 'session'; revision: string };

export interface QueryEditorCoauthoringControllerV1<TQuery extends DataQuery = DataQuery> {
  getSnapshot(): QueryEditorCoauthoringSnapshotV1;
  subscribe(listener: VoidFunction): VoidFunction;
  getPortalTarget(): HTMLElement;
  begin(): Promise<QueryEditorCoauthoringContextV1>;
  refreshContext(): Promise<QueryEditorCoauthoringContextV1>;
  stageEditorDiff(
    source: string
  ):
    | {
        status: 'staged';
        query: TQuery;
        queryKey: string;
        baselineRevision: string;
        changes: QueryEditorCoauthoringChangeV1[];
      }
    | { status: 'rejected'; reason: 'invalid' | 'unchanged' | 'stale' };
  clearEditorDiff(): void;
  focus(): void;
  dismiss(): void;
  dispose(): void;
}

export interface QueryEditorCoauthoringV1Props {
  surfaceGeneration: string;
  createController(): QueryEditorCoauthoringControllerV1;
  onSurfaceStateChange(event: { generation: string; state: 'ready' | 'unavailable' | 'failed' }): void;
}

export interface QueryEditorCoauthoringHostDescriptorV1 {
  componentId: 'grafana/query-editor-coauthoring/v1';
  generation: string;
  queryKey: string;
  surfaceState: 'pending' | 'ready' | 'unavailable' | 'failed';
  onSurfaceStateChange(event: { generation: string; state: 'ready' | 'unavailable' | 'failed' }): void;
}
