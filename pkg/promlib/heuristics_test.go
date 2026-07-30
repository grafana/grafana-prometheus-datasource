package promlib

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

type heuristicsSuccessRoundTripper struct {
	res    io.ReadCloser
	status int
}

func (rt *heuristicsSuccessRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{
		Status:        strconv.Itoa(rt.status),
		StatusCode:    rt.status,
		Header:        nil,
		Body:          rt.res,
		ContentLength: 0,
		Request:       req,
	}, nil
}

func newHeuristicsSDKProvider(hrt heuristicsSuccessRoundTripper) *sdkhttpclient.Provider {
	anotherFN := func(o sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		return &hrt
	}
	fn := sdkhttpclient.MiddlewareFunc(anotherFN)
	mid := sdkhttpclient.NamedMiddlewareFunc("mock", fn)
	return sdkhttpclient.NewProvider(sdkhttpclient.ProviderOptions{Middlewares: []sdkhttpclient.Middleware{mid}})
}

func mockExtendClientOpts(ctx context.Context, settings backend.DataSourceInstanceSettings, clientOpts *sdkhttpclient.Options, log log.Logger) error {
	return nil
}

// capturingRoundTripper records the outgoing request so tests can assert on the method/URL.
type capturingRoundTripper struct {
	gotReq *http.Request
	res    io.ReadCloser
	status int
}

func (rt *capturingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	rt.gotReq = req
	return &http.Response{
		Status:     strconv.Itoa(rt.status),
		StatusCode: rt.status,
		Body:       rt.res,
		Request:    req,
	}, nil
}

func newCapturingSDKProvider(rt *capturingRoundTripper) *sdkhttpclient.Provider {
	fn := sdkhttpclient.MiddlewareFunc(func(o sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		return rt
	})
	mid := sdkhttpclient.NamedMiddlewareFunc("mock", fn)
	return sdkhttpclient.NewProvider(sdkhttpclient.ProviderOptions{Middlewares: []sdkhttpclient.Middleware{mid}})
}

func Test_GetHeuristics(t *testing.T) {
	t.Run("should return Prometheus", func(t *testing.T) {
		rt := heuristicsSuccessRoundTripper{
			res:    io.NopCloser(strings.NewReader("{\"status\":\"success\",\"data\":{\"version\":\"1.0\"}}")),
			status: http.StatusOK,
		}
		httpProvider := newHeuristicsSDKProvider(rt)
		logger := backend.NewLoggerWith("logger", "test")
		s := &Service{
			im:     datasource.NewInstanceManager(newInstanceSettings(httpProvider, logger, mockExtendClientOpts)),
			logger: logger,
		}

		req := HeuristicsRequest{
			PluginContext: getPluginContext(),
		}
		res, err := s.GetHeuristics(context.Background(), req)
		assert.NoError(t, err)
		require.NotNil(t, res)
		assert.Equal(t, KindPrometheus, res.Application)
		assert.Equal(t, Features{RulerApiEnabled: false}, res.Features)
	})

	t.Run("should return Mimir", func(t *testing.T) {
		rt := heuristicsSuccessRoundTripper{
			res:    io.NopCloser(strings.NewReader("{\"status\":\"success\",\"data\":{\"features\":{\"foo\":\"bar\"},\"version\":\"1.0\"}}")),
			status: http.StatusOK,
		}
		httpProvider := newHeuristicsSDKProvider(rt)
		logger := backend.NewLoggerWith("logger", "test")
		s := &Service{
			im:     datasource.NewInstanceManager(newInstanceSettings(httpProvider, logger, mockExtendClientOpts)),
			logger: logger,
		}

		req := HeuristicsRequest{
			PluginContext: getPluginContext(),
		}
		res, err := s.GetHeuristics(context.Background(), req)
		assert.NoError(t, err)
		require.NotNil(t, res)
		assert.Equal(t, KindMimir, res.Application)
		assert.Equal(t, Features{RulerApiEnabled: true}, res.Features)
	})

	t.Run("buildinfo request is always sent as GET even for POST-configured datasources", func(t *testing.T) {
		// Regression test: /api/v1/status/buildinfo is GET-only. getBuildInfo must force GET so the
		// request does not inherit the datasource's configured POST method and get a 405 back.
		rt := &capturingRoundTripper{
			res:    io.NopCloser(strings.NewReader(`{"status":"success","data":{"version":"1.0"}}`)),
			status: http.StatusOK,
		}
		httpProvider := newCapturingSDKProvider(rt)
		logger := backend.NewLoggerWith("logger", "test")
		s := &Service{
			im:     datasource.NewInstanceManager(newInstanceSettings(httpProvider, logger, mockExtendClientOpts)),
			logger: logger,
		}

		// getPluginContext configures the datasource with httpMethod POST (see helper).
		res, err := s.GetHeuristics(context.Background(), HeuristicsRequest{PluginContext: getPluginContext()})
		require.NoError(t, err)
		require.NotNil(t, res)
		require.NotNil(t, rt.gotReq)
		assert.Equal(t, http.MethodGet, rt.gotReq.Method)
		assert.Equal(t, "/api/v1/status/buildinfo", rt.gotReq.URL.Path)
	})
}
