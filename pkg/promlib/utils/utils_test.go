package utils

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"io"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/stretchr/testify/require"
)

func TestDecode(t *testing.T) {
	body := []byte("prometheus response")

	tests := []struct {
		name     string
		encoding string
		body     []byte
	}{
		{
			name:     "no compression",
			encoding: "",
			body:     body,
		},
		{
			name:     "gzip",
			encoding: "gzip",
			body:     gzipBody(t, body),
		},
		{
			name:     "deflate",
			encoding: "deflate",
			body:     deflateBody(t, body),
		},
		{
			name:     "brotli",
			encoding: "br",
			body:     brotliBody(t, body),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			decoded, err := Decode(tc.encoding, io.NopCloser(bytes.NewReader(tc.body)))

			require.NoError(t, err)
			require.Equal(t, body, decoded)
		})
	}
}

func TestDecodeReturnsErrorForInvalidGzip(t *testing.T) {
	_, err := Decode("gzip", io.NopCloser(bytes.NewReader([]byte("not gzip"))))

	require.Error(t, err)
}

func TestDecodeReturnsErrorUnknownEncoding(t *testing.T) {
	_, err := Decode("zstd", io.NopCloser(bytes.NewReader([]byte("body"))))

	require.EqualError(t, err, `unexpected encoding type "zstd"`)
}

func gzipBody(t *testing.T, body []byte) []byte {
	t.Helper()

	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	_, err := writer.Write(body)
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	return buf.Bytes()
}

func deflateBody(t *testing.T, body []byte) []byte {
	t.Helper()

	var buf bytes.Buffer
	writer, err := flate.NewWriter(&buf, flate.DefaultCompression)
	require.NoError(t, err)
	_, err = writer.Write(body)
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	return buf.Bytes()
}

func brotliBody(t *testing.T, body []byte) []byte {
	t.Helper()

	var buf bytes.Buffer
	writer := brotli.NewWriter(&buf)
	_, err := writer.Write(body)
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	return buf.Bytes()
}
