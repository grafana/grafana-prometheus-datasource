package resource_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/require"
)

type timeoutError struct{}

func (timeoutError) Error() string   { return "dial tcp: i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return false }

func TestResourceTransportErrorsKeepTheirSource(t *testing.T) {
	tests := []struct {
		name           string
		err            error
		wantDownstream bool
	}{
		{name: "error marked downstream", err: backend.DownstreamError(errors.New("too many concurrent requests to host")), wantDownstream: true},
		{name: "timeout", err: timeoutError{}, wantDownstream: true},
		{name: "cancellation", err: context.Canceled, wantDownstream: true},
		{name: "unmarked error", err: errors.New("unexpected failure"), wantDownstream: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, settings, logger := setup()
			client := &http.Client{Transport: &mockRoundTripper{Err: tc.err}}
			res, err := newResource(t, client, settings, logger)
			require.NoError(t, err)
			req := &backend.CallResourceRequest{Method: http.MethodGet, Path: "api/v1/labels", URL: "/api/v1/labels"}

			_, executeErr := res.Execute(context.Background(), req)
			searchErr := res.ExecuteSearch(context.Background(), req, backend.CallResourceResponseSenderFunc(func(*backend.CallResourceResponse) error {
				return nil
			}))

			for _, got := range []error{executeErr, searchErr} {
				require.ErrorIs(t, got, tc.err)
				require.Equal(t, tc.wantDownstream, backend.IsDownstreamError(got))
			}
		})
	}
}
