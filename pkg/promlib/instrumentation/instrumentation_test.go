package instrumentation

import (
	"context"
	"fmt"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	dto "github.com/prometheus/client_model/go"
)

func checkErrorSource(t *testing.T, expected, actual string) {
	t.Helper()
	if expected != actual {
		t.Errorf("expected errorSource to be %v, but got %v", expected, actual)
	}
}

func TestGetErrorSourceForResponse(t *testing.T) {
	t.Run("A response that return an error should return pluginSource", func(t *testing.T) {
		errorSource := getErrorSourceForResponse(backend.DataResponse{Error: fmt.Errorf("error")})
		checkErrorSource(t, PluginSource, errorSource)
	})

	t.Run("A response with an http satus code > 500 should return databaseSource", func(t *testing.T) {
		errorSource := getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 500})
		checkErrorSource(t, DatabaseSource, errorSource)

		errorSource = getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 503})
		checkErrorSource(t, DatabaseSource, errorSource)

		errorSource = getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 507})
		checkErrorSource(t, DatabaseSource, errorSource)
	})

	t.Run("A response with an http satus related to auth (401, 402, 403, 407), should return externalSource", func(t *testing.T) {
		errorSource := getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 401})
		checkErrorSource(t, ExternalSource, errorSource)

		errorSource = getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 402})
		checkErrorSource(t, ExternalSource, errorSource)

		errorSource = getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 403})
		checkErrorSource(t, ExternalSource, errorSource)

		errorSource = getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 407})
		checkErrorSource(t, ExternalSource, errorSource)
	})

	t.Run("A response with an http satus of 4xx but not related to auth (401, 402, 403, 407), should return pluginSource", func(t *testing.T) {
		errorSource := getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 400})
		checkErrorSource(t, PluginSource, errorSource)

		errorSource = getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 404})
		checkErrorSource(t, PluginSource, errorSource)

		errorSource = getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 405})
		checkErrorSource(t, PluginSource, errorSource)
	})

	t.Run("A downstream error is labelled by the status the server returned", func(t *testing.T) {
		for _, tc := range []struct {
			status backend.Status
			want   string
		}{
			{backend.StatusBadGateway, DatabaseSource},
			{backend.StatusBadRequest, DatabaseSource},
			{backend.StatusUnauthorized, ExternalSource},
			{0, DatabaseSource},
		} {
			got := getErrorSourceForResponse(backend.DataResponse{
				Error:       fmt.Errorf("dial tcp: i/o timeout"),
				ErrorSource: backend.ErrorSourceDownstream,
				Status:      tc.status,
			})
			checkErrorSource(t, tc.want, got)
		}
	})

	t.Run("A response without error and with an http status of 2xx, should return noneSource", func(t *testing.T) {
		errorSource := getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 200})
		checkErrorSource(t, NoneSource, errorSource)

		errorSource = getErrorSourceForResponse(backend.DataResponse{Error: nil, Status: 201})
		checkErrorSource(t, NoneSource, errorSource)
	})
}

func TestGetErrorSource(t *testing.T) {
	t.Run("If status of backend.QueryDataResponse is statusError, then errorSource is pluginSource ", func(t *testing.T) {
		errorSource := getErrorSource(fmt.Errorf("a random error"), nil)
		checkErrorSource(t, PluginSource, errorSource)
	})

	t.Run("If status of backend.QueryDataResponse is statusOK, then errorSource is the most severe response's errorSource: pluginSource > databaseSource > externalSource > noneSource", func(t *testing.T) {
		errorSource := getErrorSource(nil, &backend.QueryDataResponse{
			Responses: map[string]backend.DataResponse{
				"A": {Error: fmt.Errorf("error")},
				"B": {Error: nil, Status: 200},
			},
		})
		checkErrorSource(t, PluginSource, errorSource)

		errorSource = getErrorSource(nil, &backend.QueryDataResponse{
			Responses: map[string]backend.DataResponse{
				"A": {Error: nil, Status: 400},
				"B": {Error: nil, Status: 500},
				"C": {Error: nil, Status: 401},
				"D": {Error: nil, Status: 200},
			},
		})
		checkErrorSource(t, PluginSource, errorSource)

		errorSource = getErrorSource(nil, &backend.QueryDataResponse{
			Responses: map[string]backend.DataResponse{
				"B": {Error: nil, Status: 500},
				"C": {Error: nil, Status: 401},
				"D": {Error: nil, Status: 200},
			},
		})
		checkErrorSource(t, DatabaseSource, errorSource)

		errorSource = getErrorSource(nil, &backend.QueryDataResponse{
			Responses: map[string]backend.DataResponse{
				"C": {Error: nil, Status: 401},
				"D": {Error: nil, Status: 200},
			},
		})
		checkErrorSource(t, ExternalSource, errorSource)

		errorSource = getErrorSource(nil, &backend.QueryDataResponse{
			Responses: map[string]backend.DataResponse{
				"D": {Error: nil, Status: 200},
			},
		})
		checkErrorSource(t, NoneSource, errorSource)
	})
}

func TestUpdateQueryDataMetricsStatus(t *testing.T) {
	succeeded := backend.DataResponse{Status: backend.StatusOK}
	failed := backend.DataResponse{Error: fmt.Errorf("bad_data"), ErrorSource: backend.ErrorSourceDownstream, Status: backend.StatusBadRequest}
	cancelled := backend.DataResponse{Error: context.Canceled, ErrorSource: backend.ErrorSourceDownstream, Status: backend.StatusBadGateway}
	tests := []struct {
		name       string
		err        error
		resp       *backend.QueryDataResponse
		wantStatus string
		wantSource string
	}{
		{
			name:       "a failed query",
			resp:       &backend.QueryDataResponse{Responses: backend.Responses{"A": failed}},
			wantStatus: "error",
			wantSource: DatabaseSource,
		},
		{
			name:       "a cancelled query",
			resp:       &backend.QueryDataResponse{Responses: backend.Responses{"A": cancelled}},
			wantStatus: "cancelled",
			wantSource: NoneSource,
		},
		{
			name:       "a successful query",
			resp:       &backend.QueryDataResponse{Responses: backend.Responses{"A": succeeded}},
			wantStatus: "ok",
			wantSource: NoneSource,
		},
		{
			name:       "a successful query and a failed query",
			resp:       &backend.QueryDataResponse{Responses: backend.Responses{"A": succeeded, "B": failed}},
			wantStatus: "error",
			wantSource: DatabaseSource,
		},
		{
			name:       "a cancelled query and a failed query",
			resp:       &backend.QueryDataResponse{Responses: backend.Responses{"A": cancelled, "B": failed}},
			wantStatus: "error",
			wantSource: DatabaseSource,
		},
		{
			name:       "a request error",
			err:        fmt.Errorf("query contains no queries"),
			wantStatus: "error",
			wantSource: PluginSource,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			count := func() float64 {
				var m dto.Metric
				if err := pluginRequestCounter.WithLabelValues(EndpointQueryData, tc.wantStatus, tc.wantSource).Write(&m); err != nil {
					t.Fatal(err)
				}
				return m.GetCounter().GetValue()
			}
			before := count()

			UpdateQueryDataMetrics(tc.err, tc.resp)

			if got := count() - before; got != 1 {
				t.Errorf("UpdateQueryDataMetrics counted %v requests with status %q and errorSource %q, want 1", got, tc.wantStatus, tc.wantSource)
			}
		})
	}
}
