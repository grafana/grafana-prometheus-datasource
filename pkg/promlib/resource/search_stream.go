package resource

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// Search endpoints exposed by Prometheus/Mimir's experimental NDJSON streaming
// search API (gated upstream by --enable-feature=search-api). These are the ONLY
// upstream paths the streaming handler is allowed to reach (SSRF protection).
const (
	SearchMetricNames = "metric_names"
	SearchLabelNames  = "label_names"
	SearchLabelValues = "label_values"
)

// searchBasePath is the upstream path prefix for the search API.
const searchBasePath = "/api/v1/search/"

// IsValidSearchEndpoint reports whether endpoint is one of the allowlisted search
// endpoints. It is shared by SubscribeStream and PublishStream so the allowlist is
// enforced in a single place.
func IsValidSearchEndpoint(endpoint string) bool {
	switch endpoint {
	case SearchMetricNames, SearchLabelNames, SearchLabelValues:
		return true
	default:
		return false
	}
}

// SearchLine is a single decoded NDJSON line from the upstream search API.
//
// The upstream emits three shapes, distinguished by the Status field:
//   - Batch:    {"results":[...], "warnings":[...]}                      (Status == "")
//   - Trailer:  {"status":"success","has_more":bool,"warnings":[...]}    (Status == "success")
//   - Error:    {"status":"error","errorType":...,"error":...}           (Status == "error")
//
// Results are kept as raw JSON so the record shape (metric_names vs label_names vs
// label_values) is forwarded verbatim and decoded on the frontend. Unknown trailer
// fields are ignored per the upstream contract.
type SearchLine struct {
	Results  []json.RawMessage `json:"results,omitempty"`
	Warnings []string          `json:"warnings,omitempty"`
	Status   string            `json:"status,omitempty"`
	HasMore  bool              `json:"has_more,omitempty"`
	ErrType  string            `json:"errorType,omitempty"`
	Error    string            `json:"error,omitempty"`
}

// IsTerminal reports whether the line terminates the stream (success trailer or error).
func (l SearchLine) IsTerminal() bool {
	return l.Status == "success" || l.Status == "error"
}

// IsError reports whether the line is an error line.
func (l SearchLine) IsError() bool {
	return l.Status == "error"
}

// maxSearchLineSize bounds an individual NDJSON line to avoid unbounded memory growth
// from a hostile/buggy upstream. Lines larger than this abort the read with an error.
const maxSearchLineSize = 8 * 1024 * 1024

// StreamSearch performs a streaming NDJSON read against the upstream search API and
// invokes onLine for every decoded line (batch, trailer or error), in order.
//
// It deliberately uses the raw *http.Response from client.QueryResource (instead of
// Resource.Execute, which buffers the whole body) so batches can be forwarded
// incrementally. The caller's ctx controls cancellation/timeout; an abrupt EOF
// without a trailer is treated as a clean end of stream (returns nil) so callers can
// resolve with whatever was collected.
//
// GET is always used: the upstream search endpoints accept GET and it avoids
// POST-disallowed servers (the resource fallback-to-GET retry does not apply to streams).
func (r *Resource) StreamSearch(ctx context.Context, endpoint string, params url.Values, onLine func(SearchLine) error) error {
	if !IsValidSearchEndpoint(endpoint) {
		return fmt.Errorf("invalid search endpoint: %q", endpoint)
	}

	path := searchBasePath + endpoint
	rawQuery := params.Encode()
	reqURL := path
	if rawQuery != "" {
		reqURL = path + "?" + rawQuery
	}

	req := &backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   path,
		URL:    reqURL,
	}

	resp, err := r.promClient.QueryResource(ctx, req)
	if err != nil {
		return err
	}
	defer func() {
		_ = resp.Body.Close()
	}()

	// Errors before the first batch arrive as a normal Prometheus JSON error with a
	// 4xx/5xx code. Surface those as an error line.
	if resp.StatusCode >= http.StatusBadRequest {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		var le SearchLine
		if json.Unmarshal(bytes.TrimSpace(body), &le) == nil && (le.Error != "" || le.ErrType != "") {
			return onLine(SearchLine{Status: "error", Error: le.Error, ErrType: le.ErrType})
		}
		return fmt.Errorf("search request failed with status %d: %s", resp.StatusCode, string(body))
	}

	reader := bufio.NewReaderSize(resp.Body, 64*1024)
	var pending []byte // accumulates a single (possibly chunked, possibly large) line
	lineNumber := 0
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		chunk, readErr := reader.ReadSlice('\n')
		if len(chunk) > 0 {
			pending = append(pending, chunk...)
			if len(pending) > maxSearchLineSize {
				return fmt.Errorf("search NDJSON line exceeded %d bytes", maxSearchLineSize)
			}
			// A complete line is one terminated by '\n' (readErr == nil). On EOF the
			// trailing bytes (if any) are processed below after the loop check.
			if readErr == nil {
				lineNumber++
				terminal, err := emitLine(pending, lineNumber, onLine)
				if err != nil {
					return err
				}
				if terminal {
					return nil
				}
				pending = pending[:0]
			}
		}

		if readErr == bufio.ErrBufferFull {
			continue
		}
		if readErr != nil {
			if readErr == io.EOF {
				// Process any trailing line without a newline, then treat the abrupt
				// EOF (no trailer) as a clean completion.
				if len(bytes.TrimSpace(pending)) > 0 {
					lineNumber++
					_, err := emitLine(pending, lineNumber, onLine)
					if err != nil {
						return err
					}
				}
				return nil
			}
			return readErr
		}
	}
}

// emitLine decodes a single NDJSON line and forwards it to onLine. Blank lines are
// skipped; malformed JSON terminates the read with its physical line number so callers
// can retain already-delivered batches while surfacing incomplete results.
func emitLine(line []byte, lineNumber int, onLine func(SearchLine) error) (bool, error) {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		return false, nil
	}
	var sl SearchLine
	if err := json.Unmarshal(trimmed, &sl); err != nil {
		return false, fmt.Errorf("invalid search NDJSON at line %d: %w", lineNumber, err)
	}
	if err := onLine(sl); err != nil {
		return false, err
	}
	return sl.IsTerminal(), nil
}
