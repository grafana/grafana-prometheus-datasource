package resource

import (
	"context"
	"fmt"
	"io"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const searchStreamBufferSize = 16 * 1024

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
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return fmt.Errorf("error reading search error response: %v", err)
		}
		return sender.Send(&backend.CallResourceResponse{
			Status:  resp.StatusCode,
			Headers: resp.Header,
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
			return nil
		}
	}
}
