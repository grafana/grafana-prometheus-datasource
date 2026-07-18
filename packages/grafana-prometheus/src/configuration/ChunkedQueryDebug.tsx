import { useRef, useState } from 'react';

import { t } from '@grafana/i18n';
import { config } from '@grafana/runtime';
import { Alert, Button, Collapse, InlineField, Input, Stack, TextArea } from '@grafana/ui';

import {
  addChunkedQueryEvent,
  consumeJSONLStream,
  createChunkedQueryResult,
  createChunkedQueryURL,
  type ChunkedQueryResult,
} from './chunked_query_debug';

interface Props {
  datasourceUID?: string;
}

export function ChunkedQueryDebug({ datasourceUID }: Props) {
  const abortController = useRef<AbortController>();
  const [isOpen, setIsOpen] = useState(false);
  const [expression, setExpression] = useState('up');
  const [from, setFrom] = useState('now-30m');
  const [to, setTo] = useState('now');
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<ChunkedQueryResult>();
  const [error, setError] = useState<string>();

  const runQuery = async () => {
    if (!datasourceUID || !expression.trim()) {
      return;
    }

    const controller = new AbortController();
    abortController.current = controller;
    const startedAt = performance.now();
    const nextResult = createChunkedQueryResult();
    setError(undefined);
    setResult(nextResult);
    setIsRunning(true);

    try {
      // The runtime request client parses responses before returning them, which
      // would hide each JSONL boundary this diagnostic needs to observe.
      const response = await fetch(createChunkedQueryURL(config.appSubUrl, config.namespace, datasourceUID), {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          Accept: 'text/jsonl',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to,
          queries: [
            {
              refId: 'A',
              expr: expression,
              range: true,
              instant: false,
              intervalMs: 1000,
              maxDataPoints: 2000,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error((await response.text()) || response.statusText);
      }
      if (!response.body) {
        throw new Error(
          t('grafana-prometheus.chunked-query-debug.error-stream-unavailable', 'The browser did not expose a response stream.')
        );
      }

      await consumeJSONLStream(response.body, (event) => {
        addChunkedQueryEvent(nextResult, event, performance.now() - startedAt);
        setResult({ ...nextResult, frames: new Map(nextResult.frames), errors: [...nextResult.errors] });
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (abortController.current === controller) {
        abortController.current = undefined;
      }
      setIsRunning(false);
    }
  };

  const cancelQuery = () => abortController.current?.abort();
  const frames = result ? Array.from(result.frames, ([id, frame]) => ({ id, frame })) : [];

  return (
    <Collapse
      label={t('grafana-prometheus.chunked-query-debug.title', 'Experimental chunked query consumer')}
      isOpen={isOpen}
      onToggle={() => setIsOpen((open) => !open)}
    >
      <Stack direction="column" gap={1}>
        <Alert
          severity="info"
          title={t('grafana-prometheus.chunked-query-debug.notice-title', 'Debug-only experimental consumer')}
        >
          {t(
            'grafana-prometheus.chunked-query-debug.notice-body',
            'Runs one supported range query against the raw JSONL endpoint. It does not change Explore or dashboard queries.'
          )}
        </Alert>
        {!datasourceUID && (
          <Alert
            severity="warning"
            title={t('grafana-prometheus.chunked-query-debug.unsaved-title', 'Save this data source first')}
          >
            {t(
              'grafana-prometheus.chunked-query-debug.unsaved-body',
              'The data source needs a UID before a chunked query can be sent.'
            )}
          </Alert>
        )}
        <InlineField label={t('grafana-prometheus.chunked-query-debug.expression', 'Expression')} grow>
          <TextArea
            aria-label={t('grafana-prometheus.chunked-query-debug.expression', 'Expression')}
            value={expression}
            onChange={(event) => setExpression(event.currentTarget.value)}
          />
        </InlineField>
        <Stack gap={1}>
          <InlineField label={t('grafana-prometheus.chunked-query-debug.from', 'From')}>
            <Input value={from} onChange={(event) => setFrom(event.currentTarget.value)} />
          </InlineField>
          <InlineField label={t('grafana-prometheus.chunked-query-debug.to', 'To')}>
            <Input value={to} onChange={(event) => setTo(event.currentTarget.value)} />
          </InlineField>
          <Button disabled={!datasourceUID || !expression.trim() || isRunning} onClick={runQuery}>
            {t('grafana-prometheus.chunked-query-debug.run', 'Run chunked query')}
          </Button>
          {isRunning && (
            <Button variant="secondary" onClick={cancelQuery}>
              {t('grafana-prometheus.chunked-query-debug.cancel', 'Cancel')}
            </Button>
          )}
        </Stack>
        {error && (
          <Alert severity="error" title={t('grafana-prometheus.chunked-query-debug.request-failed', 'Request failed')}>
            {error}
          </Alert>
        )}
        {result && (
          <>
            <div>
              {t(
                'grafana-prometheus.chunked-query-debug.summary',
                'First frame: {{firstFrameAtMs}} ms · Chunks: {{chunkCount}} · Accumulated frames: {{frameCount}}',
                {
                  firstFrameAtMs: result.firstFrameAtMs?.toFixed(1) ?? 'not received',
                  chunkCount: result.chunkCount,
                  frameCount: frames.length,
                }
              )}
            </div>
            {result.errors.map((chunkError, index) => (
              <Alert key={`${chunkError.refId}-${index}`} severity="error" title={`${chunkError.refId}: ${chunkError.error}`}>
                {chunkError.errorSource}
              </Alert>
            ))}
            {frames.map(({ id, frame }) => (
              <div key={id}>
                <strong>{id}</strong>
                <pre>{JSON.stringify(frame, null, 2)}</pre>
              </div>
            ))}
          </>
        )}
      </Stack>
    </Collapse>
  );
}
