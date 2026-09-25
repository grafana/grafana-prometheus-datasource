package utils

import (
	"bytes"
	"compress/gzip"
	"io"
	"testing"

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
			name:     "identity",
			encoding: "identity",
			body:     body,
		},
		{
			name:     "gzip",
			encoding: "gzip",
			body:     gzipBody(t, body),
		},
		{
			name:     "gzip is case-insensitive",
			encoding: "GZIP",
			body:     gzipBody(t, body),
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

// zstd, deflate, br, and other unlisted encodings are deliberately unsupported:
// QueryResource pins Accept-Encoding to gzip, so anything else means the
// upstream ignored content negotiation and must surface as an error.
func TestDecodeReturnsErrorForUnexpectedEncoding(t *testing.T) {
	for _, encoding := range []string{"zstd", "lzma", "deflate", "br"} {
		t.Run(encoding, func(t *testing.T) {
			_, err := Decode(encoding, io.NopCloser(bytes.NewReader([]byte("body"))))

			require.EqualError(t, err, `unexpected encoding type "`+encoding+`"`)
		})
	}
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

