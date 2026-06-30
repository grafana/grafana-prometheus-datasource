package utils

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"context"
	"fmt"
	"io"

	"github.com/andybalholm/brotli"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

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

// Adapted from grafana/grafana-azuremonitor-datasource
// This function handles various compression mechanisms that may have been used on a response body
// Determine encoding by: encoding := resp.Header.Get("Content-Encoding")
func Decode(encoding string, original io.ReadCloser) ([]byte, error) {
	var reader io.Reader
	var err error
	switch encoding {
	case "gzip":
		reader, err = gzip.NewReader(original)
		if err != nil {
			return nil, err
		}
		defer func() {
			if err := reader.(io.ReadCloser).Close(); err != nil {
				backend.Logger.Warn("Failed to close reader body", "err", err)
			}
		}()
	case "deflate":
		reader = flate.NewReader(original)
		defer func() {
			if err := reader.(io.ReadCloser).Close(); err != nil {
				backend.Logger.Warn("Failed to close reader body", "err", err)
			}
		}()
	case "br":
		reader = brotli.NewReader(original)
	case "":
		reader = original
	default:
		return nil, fmt.Errorf("unexpected encoding type %q", encoding)
	}

	var buf bytes.Buffer
	_, err = buf.ReadFrom(reader)
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
