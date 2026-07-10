import { expect, test } from '@grafana/plugin-e2e';

// These tests exercise the datasource *resource* path (labels, label values,
// rules) end-to-end through Grafana's externalized-plugin proxy. This is the
// path that regressed in production: the plugin decoded the gzip body but
// relayed the upstream's stale Content-Encoding/Content-Length, so the proxy
// hit a framing mismatch and returned HTTP 500. Queries were unaffected because
// they never relay raw upstream framing.
//
// The provisioned 'prometheus' datasource points at the gzip-forcing proxy (see
// docker-compose.yaml), so every response here is gzip-compressed with an
// explicit Content-Length — the exact shape that triggers the bug. A plain
// smoke test that only checks UI rendering would stay green while this path is
// broken; asserting a real 200 + decoded JSON body is what catches it.

const DATASOURCE_UID = 'prometheus';
const resourcePath = (p: string) => `/api/datasources/uid/${DATASOURCE_UID}/resources${p}`;

// Deliberately assert only on the framing/decoding contract (200 + a
// well-formed, decoded JSON envelope), NOT on the presence of specific labels
// or metric names. The latter depends on Prometheus having completed at least
// one scrape, which is a startup race the test must not couple to. If the
// header-framing bug regresses, the proxy returns a 500 or the body fails to
// decode into JSON here regardless of whether any series exist yet.
test.describe('Resource calls (externalized plugin, gzip upstream)', () => {
  test('label names resource call returns 200 with a decoded JSON body', { tag: '@plugins' }, async ({ request }) => {
    const res = await request.get(resourcePath('/api/v1/labels'));

    expect(res.status(), 'labels resource call must not 500 on a gzip framing mismatch').toBe(200);

    const json = await res.json();
    expect(json.status).toBe('success');
    expect(Array.isArray(json.data)).toBe(true);
  });

  test('label values resource call returns 200 with a decoded JSON body', { tag: '@plugins' }, async ({ request }) => {
    const res = await request.get(resourcePath('/api/v1/label/__name__/values'));

    expect(res.status(), 'label values resource call must not 500 on a gzip framing mismatch').toBe(200);

    const json = await res.json();
    expect(json.status).toBe('success');
    expect(Array.isArray(json.data)).toBe(true);
  });
});
