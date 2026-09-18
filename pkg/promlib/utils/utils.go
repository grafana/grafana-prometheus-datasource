package utils

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// GetJsonData just gets the json in easier to work with type. It's used on multiple places which isn't super effective
// but only when creating a client which should not happen often anyway.
func GetJsonData(settings backend.DataSourceInstanceSettings) (map[string]any, error) {
	var jsonData map[string]any
	err := json.Unmarshal(settings.JSONData, &jsonData)
	if err != nil {
		return nil, fmt.Errorf("error unmarshalling JSONData: %w", err)
	}
	return jsonData, nil
}

// StartTrace setups a trace but does not panic if tracer is nil which helps with testing
func StartTrace(ctx context.Context, tracer trace.Tracer, name string, attributes ...attribute.KeyValue) (context.Context, func()) {
	if tracer == nil {
		return ctx, func() {}
	}
	ctx, span := tracer.Start(ctx, name, trace.WithAttributes(attributes...))
	return ctx, func() {
		span.End()
	}
}

// NewDecodingReader wraps original in a reader that yields plaintext for the given
// Content-Encoding. QueryResource pins the upstream Accept-Encoding to gzip, so a
// well-behaved upstream answers with "gzip" or an empty/"identity" header. Anything
// else means the upstream ignored content negotiation with an encoding we cannot
// decode, and callers must treat that as an error rather than forward bytes they
// cannot decode.
func NewDecodingReader(encoding string, original io.Reader) (io.Reader, error) {
	switch {
	case strings.EqualFold(encoding, "gzip"):
		return gzip.NewReader(original)
	case encoding == "" || strings.EqualFold(encoding, "identity"):
		return original, nil
	default:
		return nil, fmt.Errorf("unexpected encoding type %q", encoding)
	}
}

// Decode buffers the full plaintext body for the given Content-Encoding.
// Determine encoding by: encoding := resp.Header.Get("Content-Encoding")
func Decode(encoding string, original io.ReadCloser) ([]byte, error) {
	reader, err := NewDecodingReader(encoding, original)
	if err != nil {
		return nil, err
	}
	if closer, ok := reader.(io.Closer); ok {
		defer func() {
			if err := closer.Close(); err != nil {
				backend.Logger.Warn("Failed to close reader body", "err", err)
			}
		}()
	}

	var buf bytes.Buffer
	if _, err := buf.ReadFrom(reader); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
