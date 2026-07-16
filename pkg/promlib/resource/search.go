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

	streamReq := *req
	streamReq.Headers = map[string][]string(req.GetHTTPHeaders().Clone())
	if streamReq.Headers == nil {
		streamReq.Headers = make(map[string][]string)
	}
	streamReq.Headers["Accept-Encoding"] = []string{"identity"}

	resp, err := r.promClient.QueryResource(ctx, &streamReq)
	if err != nil {
		return fmt.Errorf("error querying search resource: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
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
	if headers == nil {
		headers = make(http.Header)
	}
	headers.Set("Content-Type", "application/x-ndjson; charset=utf-8")
	headers.Del("Content-Length")
	headers.Del("Content-Encoding")
	headers.Del("Transfer-Encoding")

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
			chunk := append([]byte(nil), buffer[:n]...)
			if err := sender.Send(&backend.CallResourceResponse{Body: chunk}); err != nil {
				return err
			}
		}
		if readErr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return nil
		}
	}
}
