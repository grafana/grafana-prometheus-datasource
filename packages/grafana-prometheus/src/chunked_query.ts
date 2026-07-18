import {
  dataFrameFromJSON,
  type DataSourceRef,
  type DataFrameJSON,
  type DataQueryError,
  type DataQueryRequest,
  type DataQueryResponse,
  LoadingState,
} from '@grafana/data';
import { config, getBackendSrv, isExpressionReference } from '@grafana/runtime';
import { Observable, Subscriber } from 'rxjs';
import { gte, prerelease, valid } from 'semver';

import { type PromQuery } from './types';

const minimumGrafanaVersion = '13.1.0';
const maximumJSONLLineLength = 1024 * 1024;

export interface ChunkedQueryEvent {
  refId: string;
  frameId?: string;
  frame?: DataFrameJSON;
  error?: string;
  errorSource?: string;
  status?: number;
  complete?: boolean;
}

export class ChunkedInfrastructureError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export function supportsChunkedQueries(version = config.buildInfo.version): boolean {
  return valid(version) !== null && prerelease(version) === null && gte(version, minimumGrafanaVersion);
}

export function createChunkedQueryURL(appSubUrl: string, namespace: string, datasourceUID: string): string {
  return `${appSubUrl}/apis/prometheus.datasource.grafana.app/v0alpha1/namespaces/${encodeURIComponent(
    namespace
  )}/datasources/${encodeURIComponent(datasourceUID)}/query`;
}

export interface ChunkedQueryDatasource {
  id?: number;
  uid: string;
  getRef(): DataSourceRef;
  applyTemplateVariables(
    target: PromQuery,
    scopedVars: DataQueryRequest<PromQuery>['scopedVars'],
    filters?: DataQueryRequest<PromQuery>['filters']
  ): PromQuery;
}

export function isChunkedQueryEligible(request: DataQueryRequest<PromQuery>, datasourceUID: string): boolean {
  return (
    request.targets.length > 0 &&
    request.targets.every(
      (target) =>
        Boolean(target.expr) &&
        !target.hide &&
        !isExpressionReference(target.datasource) &&
        (!target.datasource ||
          (typeof target.datasource === 'object' && target.datasource.uid === datasourceUID)) &&
        target.range === true &&
        target.instant !== true &&
        target.exemplar !== true &&
        target.format !== 'heatmap' &&
        !(target as PromQuery & { grafanaSql?: boolean }).grafanaSql
    )
  );
}

export function isChunkedInfrastructureError(error: unknown): error is ChunkedInfrastructureError {
  return error instanceof ChunkedInfrastructureError && (error.status === 404 || error.status === 406);
}

export function queryChunked(
  datasource: ChunkedQueryDatasource,
  request: DataQueryRequest<PromQuery>
): Observable<DataQueryResponse> {
  return new Observable((subscriber) => {
    const state = new ChunkedResponseAccumulator(subscriber);
    const subscription = getBackendSrv()
      .chunked({
        url: createChunkedQueryURL(config.appSubUrl, config.namespace, datasource.uid),
        method: 'POST',
        data: buildChunkedQueryBody(datasource, request),
        headers: {
          Accept: 'text/jsonl',
          'Content-Type': 'application/json',
        },
        requestId: request.requestId,
      })
      .subscribe({
        next: (response) => {
          if (!response.ok) {
            state.failHttp(response.status, response.statusText);
            return;
          }
          if (response.data) {
            state.consume(response.data);
          } else {
            state.complete();
          }
        },
        error: (error) => state.fail(error),
      });

    return () => subscription.unsubscribe();
  });
}

export function buildChunkedQueryBody(datasource: ChunkedQueryDatasource, request: DataQueryRequest<PromQuery>) {
  const { intervalMs, maxDataPoints, queryCachingTTL, range } = request;
  return {
    queries: request.targets.map((target) => ({
      ...datasource.applyTemplateVariables(target, request.scopedVars, request.filters),
      datasource: datasource.getRef(),
      datasourceId: datasource.id,
      intervalMs,
      maxDataPoints,
      queryCachingTTL,
    })),
    from: range?.from.valueOf().toString(),
    to: range?.to.valueOf().toString(),
  };
}

class ChunkedResponseAccumulator {
  private readonly decoder = new TextDecoder();
  private readonly frames = new Map<string, DataFrameJSON>();
  private readonly errors: DataQueryError[] = [];
  private remainder = '';
  private emitted = false;
  private completed = false;
  private terminated = false;

  constructor(private readonly subscriber: Subscriber<DataQueryResponse>) {}

  consume(chunk: Uint8Array): void {
    if (this.terminated) {
      return;
    }

    this.remainder += this.decoder.decode(chunk, { stream: true });
    if (this.remainder.length > maximumJSONLLineLength) {
      this.fail(new Error('Chunked query returned an oversized JSONL event.'));
      return;
    }
    this.consumeLines(false);
  }

  complete(): void {
    if (this.terminated) {
      return;
    }

    this.remainder += this.decoder.decode();
    this.consumeLines(true);
    if (!this.terminated && !this.completed) {
      this.fail(new Error('Chunked query stream ended before successful completion.'));
    }
  }

  failHttp(status: number, statusText: string): void {
    if (this.emitted) {
      this.fail(new Error(`Chunked query failed with status ${status}: ${statusText}`));
      return;
    }
    this.fail(new ChunkedInfrastructureError(`Chunked query failed with status ${status}: ${statusText}`, status));
  }

  fail(error: unknown): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.subscriber.error(error instanceof Error ? error : new Error(String(error)));
  }

  private consumeLines(final: boolean): void {
    let lineEnd = this.remainder.indexOf('\n');
    while (lineEnd !== -1) {
      const line = this.remainder.slice(0, lineEnd).trim();
      this.remainder = this.remainder.slice(lineEnd + 1);
      if (line) {
        this.consumeEvent(line);
      }
      if (this.terminated) {
        return;
      }
      lineEnd = this.remainder.indexOf('\n');
    }

    if (final && this.remainder.trim()) {
      this.consumeEvent(this.remainder.trim());
      this.remainder = '';
    }
  }

  private consumeEvent(line: string): void {
    let event: ChunkedQueryEvent;
    try {
      event = JSON.parse(line) as ChunkedQueryEvent;
    } catch {
      this.fail(new Error('Chunked query returned malformed JSONL.'));
      return;
    }

    if (!event) {
      this.fail(new Error('Chunked query returned an invalid event.'));
      return;
    }

    if (event.complete === true) {
      this.completed = true;
      this.terminated = true;
      this.subscriber.next({
        data: this.data(),
        errors: this.errors,
        error: this.errors[0],
        state: this.errors.length > 0 ? LoadingState.Error : LoadingState.Done,
      });
      this.subscriber.complete();
      return;
    }

    if (typeof event.refId !== 'string' || event.refId.length === 0) {
      this.fail(new Error('Chunked query event is missing a refId.'));
      return;
    }

    if (event.error) {
      this.errors.push({
        message: event.error,
        refId: event.refId,
        status: event.status,
        errorSource: event.errorSource,
      } as DataQueryError);
      this.subscriber.next({ data: this.data(), errors: this.errors, state: LoadingState.Streaming });
      return;
    }

    if (!event.frame || typeof event.frameId !== 'string' || event.frameId.length === 0) {
      this.fail(new Error('Chunked query event is missing a frame or frameId.'));
      return;
    }

    const key = JSON.stringify([event.refId, event.frameId]);
    const existing = this.frames.get(key);
    try {
      this.frames.set(key, existing ? appendFrame(existing, event.frame) : validateFrame(event.frame));
    } catch (error) {
      this.fail(error);
      return;
    }

    this.emitted = true;
    this.subscriber.next({ data: this.data(), state: LoadingState.Streaming });
  }

  private data() {
    return Array.from(this.frames.values(), (frame) => dataFrameFromJSON(cloneFrame(frame)));
  }
}

function cloneFrame(frame: DataFrameJSON): DataFrameJSON {
  return {
    ...frame,
    schema: frame.schema && {
      ...frame.schema,
      fields: frame.schema.fields.map((field) => ({ ...field })),
    },
    data: frame.data && {
      ...frame.data,
      values: frame.data.values.map((values) => [...values]),
    },
  };
}

function validateFrame(frame: DataFrameJSON): DataFrameJSON {
  if (!frame.schema?.fields || !frame.data?.values || frame.schema.fields.length !== frame.data.values.length) {
    throw new Error('Chunked query frame has an invalid schema.');
  }
  return frame;
}

function appendFrame(existing: DataFrameJSON, incoming: DataFrameJSON): DataFrameJSON {
  validateFrame(existing);
  validateFrame(incoming);
  if (JSON.stringify(existing.schema) !== JSON.stringify(incoming.schema)) {
    throw new Error('Chunked query frame schema changed between chunks.');
  }

  return {
    ...existing,
    data: {
      ...existing.data,
      values: existing.data!.values.map((values, index) => [...values, ...incoming.data!.values[index]]),
    },
  };
}
