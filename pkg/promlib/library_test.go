package promlib

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/stretchr/testify/require"
)

type fakeSender struct{}

func (sender *fakeSender) Send(resp *backend.CallResourceResponse) error {
	return nil
}

type fakeRoundtripper struct {
	Req *http.Request
}

func (rt *fakeRoundtripper) RoundTrip(req *http.Request) (*http.Response, error) {
	rt.Req = req
	return &http.Response{
		Status:        "200",
		StatusCode:    200,
		Header:        nil,
		Body:          nil,
		ContentLength: 0,
	}, nil
}

type fakeHTTPClientProvider struct {
	sdkhttpclient.Provider
	Roundtripper *fakeRoundtripper
}

func (provider *fakeHTTPClientProvider) New(opts ...sdkhttpclient.Options) (*http.Client, error) {
	client := &http.Client{}
	provider.Roundtripper = &fakeRoundtripper{}
	client.Transport = provider.Roundtripper
	return client, nil
}

func (provider *fakeHTTPClientProvider) GetTransport(opts ...sdkhttpclient.Options) (http.RoundTripper, error) {
	return &fakeRoundtripper{}, nil
}

func getMockPromTestSDKProvider(f *fakeHTTPClientProvider) *sdkhttpclient.Provider {
	anotherFN := func(o sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		_, _ = f.New()
		return f.Roundtripper
	}
	fn := sdkhttpclient.MiddlewareFunc(anotherFN)
	mid := sdkhttpclient.NamedMiddlewareFunc("mock", fn)
	return sdkhttpclient.NewProvider(sdkhttpclient.ProviderOptions{Middlewares: []sdkhttpclient.Middleware{mid}})
}

// getContextualCapturingProvider returns a provider whose client transport keeps
// the SDK's ContextualMiddleware in the chain (so per-request contextual
// middlewares registered by ForwardGrafanaHeaders actually run) and terminates
// at capture, which records the outgoing request without hitting the network.
func getContextualCapturingProvider(capture *fakeRoundtripper) *sdkhttpclient.Provider {
	captureMW := sdkhttpclient.NamedMiddlewareFunc("capture", func(_ sdkhttpclient.Options, _ http.RoundTripper) http.RoundTripper {
		return capture
	})
	return sdkhttpclient.NewProvider(sdkhttpclient.ProviderOptions{
		Middlewares: []sdkhttpclient.Middleware{
			sdkhttpclient.ContextualMiddleware(),
			captureMW,
		},
	})
}

func mockExtendTransportOptions(ctx context.Context, settings backend.DataSourceInstanceSettings, clientOpts *sdkhttpclient.Options, log log.Logger) error {
	return nil
}

func TestService(t *testing.T) {
	t.Run("Service", func(t *testing.T) {
		t.Run("CallResource", func(t *testing.T) {
			t.Run("creates correct request", func(t *testing.T) {
				f := &fakeHTTPClientProvider{}
				httpProvider := getMockPromTestSDKProvider(f)
				service := NewService(httpProvider, backend.NewLoggerWith("logger", "test"), mockExtendTransportOptions)

				req := mockRequest()
				sender := &fakeSender{}
				err := service.CallResource(context.Background(), req, sender)
				require.NoError(t, err)
				require.Equal(
					t,
					http.Header{
						"Content-Type":    {"application/x-www-form-urlencoded"},
						"Idempotency-Key": []string(nil),
					},
					f.Roundtripper.Req.Header)
				require.Equal(t, http.MethodPost, f.Roundtripper.Req.Method)
				body, err := io.ReadAll(f.Roundtripper.Req.Body)
				require.NoError(t, err)
				require.Equal(t, []byte("match%5B%5D: ALERTS\nstart: 1655271408\nend: 1655293008"), body)
				require.Equal(t, "http://localhost:9090/api/v1/series", f.Roundtripper.Req.URL.String())
			})
		})
	})

	t.Run("no extendOptions function provided", func(t *testing.T) {
		f := &fakeHTTPClientProvider{}
		httpProvider := getMockPromTestSDKProvider(f)
		service := NewService(httpProvider, backend.NewLoggerWith("logger", "test"), nil)
		require.NotNil(t, service)
		require.NotNil(t, service.im)
	})

	t.Run("extendOptions function provided", func(t *testing.T) {
		f := &fakeHTTPClientProvider{}
		httpProvider := getMockPromTestSDKProvider(f)
		service := NewService(httpProvider, backend.NewLoggerWith("logger", "test"), func(ctx context.Context, settings backend.DataSourceInstanceSettings, clientOpts *sdkhttpclient.Options, log log.Logger) error {
			fmt.Println(ctx, settings, clientOpts)
			require.NotNil(t, ctx)
			require.NotNil(t, settings)
			require.Equal(t, "test-prom", settings.Name)
			return nil
		})

		req := mockRequest()
		sender := &fakeSender{}
		err := service.CallResource(context.Background(), req, sender)
		require.NoError(t, err)
	})

	t.Run("suggest resource", func(t *testing.T) {
		f := &fakeHTTPClientProvider{}
		httpProvider := getMockPromTestSDKProvider(f)
		l := backend.NewLoggerWith("logger", "test")
		service := NewService(httpProvider, l, mockExtendTransportOptions)

		req := mockSuggestResource()
		sender := &fakeSender{}
		err := service.CallResource(context.Background(), req, sender)
		require.NoError(t, err)
		require.Equal(t, `http://localhost:9090/api/v1/labels?end=2022-06-01T12%3A00%3A00Z&limit=10&match%5B%5D=go_cgo_go_to_c_calls_calls_total%7Bjob%3D~%22.%2B%22%7D&match%5B%5D=up%7Bjob%3D~%22.%2B%22%7D&start=2022-06-01T00%3A00%3A00Z`, f.Roundtripper.Req.URL.String())
	})
}

func TestService_CallResource_ForwardsGrafanaHeaders(t *testing.T) {
	capture := &fakeRoundtripper{}
	httpProvider := getContextualCapturingProvider(capture)
	service := NewService(httpProvider, backend.NewLoggerWith("logger", "test"), mockExtendTransportOptions)

	req := mockRequest()
	// Allowlisted Grafana headers that must reach the datasource.
	req.SetHTTPHeader("X-Dashboard-Uid", "dash-123")
	req.SetHTTPHeader("X-Panel-Id", "7")
	req.SetHTTPHeader("X-Rule-Uid", "rule-abc")
	req.SetHTTPHeader("X-Rule-Name", "HighErrorRate")
	// Headers that must NOT be forwarded.
	req.SetHTTPHeader("Accept-Encoding", "gzip")
	req.SetHTTPHeader("Authorization", "Bearer secret")
	req.SetHTTPHeader("Cookie", "grafana_session=xyz")
	req.SetHTTPHeader("X-Custom-Secret", "should-not-leak")

	err := service.CallResource(context.Background(), req, &fakeSender{})
	require.NoError(t, err)

	require.NotNil(t, capture.Req, "expected an outgoing upstream request to be captured")
	got := capture.Req.Header

	require.Equal(t, "dash-123", got.Get("X-Dashboard-Uid"))
	require.Equal(t, "7", got.Get("X-Panel-Id"))
	require.Equal(t, "rule-abc", got.Get("X-Rule-Uid"))
	require.Equal(t, "HighErrorRate", got.Get("X-Rule-Name"))

	require.Empty(t, got.Get("Accept-Encoding"), "Accept-Encoding must not be forwarded upstream")
	require.Empty(t, got.Get("Authorization"), "Authorization must not be forwarded upstream")
	require.Empty(t, got.Get("Cookie"), "Cookie must not be forwarded upstream")
	require.Empty(t, got.Get("X-Custom-Secret"), "non-allowlisted headers must not be forwarded upstream")
}

func mockRequest() *backend.CallResourceRequest {
	return &backend.CallResourceRequest{
		PluginContext: backend.PluginContext{
			OrgID:               0,
			PluginID:            "prometheus",
			User:                nil,
			AppInstanceSettings: nil,
			DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
				ID:               0,
				UID:              "",
				Type:             "prometheus",
				Name:             "test-prom",
				URL:              "http://localhost:9090",
				User:             "",
				Database:         "",
				BasicAuthEnabled: true,
				BasicAuthUser:    "admin",
				Updated:          time.Time{},
				JSONData:         []byte("{}"),
			},
		},
		Path:   "/api/v1/series",
		Method: http.MethodPost,
		URL:    "/api/v1/series",
		Body:   []byte("match%5B%5D: ALERTS\nstart: 1655271408\nend: 1655293008"),
	}
}

func mockSuggestResource() *backend.CallResourceRequest {
	return &backend.CallResourceRequest{
		PluginContext: backend.PluginContext{
			OrgID:               0,
			PluginID:            "prometheus",
			User:                nil,
			AppInstanceSettings: nil,
			DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
				ID:               0,
				UID:              "",
				Type:             "prometheus",
				Name:             "test-prom",
				URL:              "http://localhost:9090",
				User:             "",
				Database:         "",
				BasicAuthEnabled: true,
				BasicAuthUser:    "admin",
				Updated:          time.Time{},
				JSONData:         []byte("{}"),
			},
		},
		Path:   "suggestions",
		URL:    "suggestions",
		Method: http.MethodPost,
		Body: []byte(`
			{
				"queries": ["up + 1", "go_cgo_go_to_c_calls_calls_total + 2"],
				"scopes": [{
					"key": "job",
					"value": ".+",
					"operator": "regex-match"
				}],
				"start": "2022-06-01T00:00:00Z",
				"end": "2022-06-01T12:00:00Z",
				"limit": 10
			}`),
	}
}
