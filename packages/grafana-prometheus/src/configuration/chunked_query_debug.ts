import { type ChunkedQueryEvent as ProductionChunkedQueryEvent } from '../chunked_query';

export { createChunkedQueryURL } from '../chunked_query';

export interface JSONDataFrame {
  schema?: unknown;
  data?: {
    values?: unknown[][];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ChunkedQueryEvent extends Omit<ProductionChunkedQueryEvent, 'frame'> {
  frame?: JSONDataFrame;
}

export interface ChunkedQueryResult {
  frames: Map<string, JSONDataFrame>;
  errors: ChunkedQueryEvent[];
  chunkCount: number;
  firstFrameAtMs?: number;
}

export interface ChunkedQueryRequest {
  from: string;
  to: string;
  queries: Array<{
    refId: string;
    expr: string;
    range: true;
    instant: false;
    intervalMs: number;
    maxDataPoints: number;
  }>;
}

export function createChunkedQueryResult(): ChunkedQueryResult {
  return {
    frames: new Map(),
    errors: [],
    chunkCount: 0,
  };
}

export function addChunkedQueryEvent(
  result: ChunkedQueryResult,
  event: ChunkedQueryEvent,
  elapsedMs: number
): ChunkedQueryResult {
  result.chunkCount++;

  if (event.frame && event.frameId) {
    const key = `${event.refId}/${event.frameId}`;
    const existing = result.frames.get(key);
    result.frames.set(key, existing ? appendFrame(existing, event.frame) : event.frame);
    result.firstFrameAtMs ??= elapsedMs;
  }

  if (event.error) {
    result.errors.push(event);
  }

  return result;
}

export async function consumeJSONLStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: ChunkedQueryEvent) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let remainder = '';

  while (true) {
    const { done, value } = await reader.read();
    remainder += decoder.decode(value, { stream: !done });

    let lineEnd: number;
    while ((lineEnd = remainder.indexOf('\n')) !== -1) {
      const line = remainder.slice(0, lineEnd).trim();
      remainder = remainder.slice(lineEnd + 1);
      if (line) {
        onEvent(JSON.parse(line) as ChunkedQueryEvent);
      }
    }

    if (done) {
      break;
    }
  }

  const trailingLine = remainder.trim();
  if (trailingLine) {
    onEvent(JSON.parse(trailingLine) as ChunkedQueryEvent);
  }
}

function appendFrame(existing: JSONDataFrame, incoming: JSONDataFrame): JSONDataFrame {
  const existingValues = existing.data?.values;
  const incomingValues = incoming.data?.values;

  if (!existingValues || !incomingValues || existingValues.length !== incomingValues.length) {
    return incoming;
  }

  return {
    ...existing,
    data: {
      ...existing.data,
      values: existingValues.map((values, index) => [...values, ...incomingValues[index]]),
    },
  };
}
