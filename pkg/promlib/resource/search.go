package resource

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const searchStreamBufferSize = 16 * 1024

// MaxSearchErrorBodyBytes caps how much of an upstream error response is read
// into memory. Search errors are small Prometheus JSON payloads, so this only
// guards against a misbehaving upstream returning an unbounded error body.
const MaxSearchErrorBodyBytes = 1 << 20 // 1 MiB

// ExecuteSearch streams a Prometheus search API response without buffering it.
func (r *Resource) ExecuteSearch(
	ctx context.Context,
	req *backend.CallResourceRequest,
	sender backend.CallResourceResponseSender,
) error {
	r.log.FromContext(ctx).Debug("Sending search resource query", "URL", req.URL)

	// Clone the request because it may be reused by the caller. Search responses
	// must stay uncompressed so chunks can be forwarded without a buffering
	// decompression step such as the one used by Resource.Execute.
	streamReq := *req
	streamReq.Headers = map[string][]string(req.GetHTTPHeaders().Clone())
	streamReq.Headers["Accept-Encoding"] = []string{"identity"}

	resp, err := r.promClient.QueryResource(ctx, &streamReq)
	if err != nil {
		return fmt.Errorf("error querying search resource: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Errors are small, non-streaming Prometheus JSON responses. Sending the
		// body once preserves the upstream status and message for Grafana's UI.
		// The read is bounded so a misbehaving upstream cannot force unbounded
		// buffering here.
		body, err := io.ReadAll(io.LimitReader(resp.Body, MaxSearchErrorBodyBytes))
		if err != nil {
			return fmt.Errorf("error reading search error response: %v", err)
		}
		// The buffered body no longer matches the upstream framing/encoding
		// headers, so strip them to avoid a length/encoding mismatch that a
		// downstream proxy would reject.
		errorHeaders := resp.Header.Clone()
		errorHeaders.Del("Content-Length")
		errorHeaders.Del("Content-Encoding")
		errorHeaders.Del("Transfer-Encoding")
		return sender.Send(&backend.CallResourceResponse{
			Status:  resp.StatusCode,
			Headers: errorHeaders,
			Body:    body,
		})
	}

	headers := resp.Header.Clone()
	headers.Set("Content-Type", "application/x-ndjson; charset=utf-8")
	headers.Del("Content-Length")
	headers.Del("Content-Encoding")
	headers.Del("Transfer-Encoding")

	// Grafana applies status and headers only from the first streamed response.
	// Later Send calls intentionally contain body bytes only.
	if err := sender.Send(&backend.CallResourceResponse{
		Status:  resp.StatusCode,
		Headers: headers,
	}); err != nil {
		return err
	}

	buffer := make([]byte, searchStreamBufferSize)
	for {
		n, readErr := resp.Body.Read(buffer)
		if n > 0 {
			// Send may outlive this iteration, so do not expose the reusable read buffer.
			chunk := append([]byte(nil), buffer[:n]...)
			if err := sender.Send(&backend.CallResourceResponse{Body: chunk}); err != nil {
				return err
			}
		}
		if readErr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// The Search API permits abrupt EOF. Results already forwarded remain
			// useful, so a transport read error ends the partial stream cleanly.
			// A non-EOF error (e.g. a reset connection) is still logged so the
			// truncation is observable rather than silently swallowed.
			if !errors.Is(readErr, io.EOF) {
				r.log.FromContext(ctx).Warn("Search stream ended with a transport error", "err", readErr)
			}
			return nil
		}
	}
}
