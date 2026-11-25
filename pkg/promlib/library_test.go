package promlib

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/stretchr/testify/require"
)

type fakeSender struct {
	Responses []*backend.CallResourceResponse
}

func (sender *fakeSender) Send(resp *backend.CallResourceResponse) error {
	sender.Responses = append(sender.Responses, resp)
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
		Body:          io.NopCloser(http.NoBody),
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
						"Accept-Encoding": {"gzip"},
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

	t.Run("NewServiceFactory sends the same request as NewService", func(t *testing.T) {
		logger := backend.NewLoggerWith("logger", "test")
		send := func(t *testing.T, newService func(*sdkhttpclient.Provider) *Service) *http.Request {
			t.Helper()
			f := &fakeHTTPClientProvider{}
			service := newService(getMockPromTestSDKProvider(f))
			require.NoError(t, service.CallResource(context.Background(), mockRequest(), &fakeSender{}))
			return f.Roundtripper.Req
		}

		want := send(t, func(p *sdkhttpclient.Provider) *Service {
			return NewService(p, logger, mockExtendTransportOptions)
		})
		got := send(t, func(p *sdkhttpclient.Provider) *Service {
			return NewServiceFactory(p, logger, mockExtendTransportOptions)(context.Background(), *mockRequest().PluginContext.DataSourceInstanceSettings)
		})

		require.Equal(t, want.Method, got.Method)
		require.Equal(t, want.URL.String(), got.URL.String())
		require.Equal(t, want.Header, got.Header)
		wantBody, err := io.ReadAll(want.Body)
		require.NoError(t, err)
		gotBody, err := io.ReadAll(got.Body)
		require.NoError(t, err)
		require.Equal(t, wantBody, gotBody)
	})

	t.Run("both constructors apply the transport and middlewares of extendOptions", func(t *testing.T) {
		var header string
		srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			header = r.Header.Get("X-Extended")
		}))
		t.Cleanup(srv.Close)
		req := mockRequest()
		req.PluginContext.DataSourceInstanceSettings.URL = srv.URL
		settings := *req.PluginContext.DataSourceInstanceSettings
		logger := backend.NewLoggerWith("logger", "test")

		for name, newService := range map[string]func(ExtendOptions) *Service{
			"NewService": func(extend ExtendOptions) *Service { return NewService(nil, logger, extend) },
			"NewServiceFactory": func(extend ExtendOptions) *Service {
				return NewServiceFactory(nil, logger, extend)(context.Background(), settings)
			},
		} {
			t.Run(name, func(t *testing.T) {
				header = ""
				configured := false
				extend := func(_ context.Context, _ backend.DataSourceInstanceSettings, opts *sdkhttpclient.Options, _ log.Logger) error {
					opts.ConfigureTransport = func(sdkhttpclient.Options, *http.Transport) { configured = true }
					opts.Middlewares = append(opts.Middlewares, sdkhttpclient.NamedMiddlewareFunc("extended",
						func(_ sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
							return sdkhttpclient.RoundTripperFunc(func(r *http.Request) (*http.Response, error) {
								r.Header.Set("X-Extended", "yes")
								return next.RoundTrip(r)
							})
						}))
					return nil
				}

				require.NoError(t, newService(extend).CallResource(context.Background(), req, &fakeSender{}))
				require.True(t, configured)
				require.Equal(t, "yes", header)
			})
		}
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

	t.Run("search resource uses streaming handler", func(t *testing.T) {
		f := &fakeHTTPClientProvider{}
		httpProvider := getMockPromTestSDKProvider(f)
		service := NewService(httpProvider, backend.NewLoggerWith("logger", "test"), mockExtendTransportOptions)

		req := mockRequest()
		req.Path = "api/v1/search/metric_names"
		req.URL = "/api/v1/search/metric_names?limit=100"
		req.Method = http.MethodGet
		req.Body = nil
		sender := &fakeSender{}

		err := service.CallResource(context.Background(), req, sender)

		require.NoError(t, err)
		require.Equal(t, "gzip", f.Roundtripper.Req.Header.Get("Accept-Encoding"))
		require.Equal(t, "http://localhost:9090/api/v1/search/metric_names?limit=100", f.Roundtripper.Req.URL.String())
		require.Len(t, sender.Responses, 1)
		require.Equal(t, "application/x-ndjson; charset=utf-8", http.Header(sender.Responses[0].Headers).Get("Content-Type"))
	})
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
