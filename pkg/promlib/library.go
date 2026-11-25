package promlib

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/client"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/instrumentation"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/resource"
)

type Service struct {
	im     instanceGetter
	logger log.Logger
}

type instanceGetter interface {
	Get(ctx context.Context, pluginContext backend.PluginContext) (instancemgmt.Instance, error)
}

type instance struct {
	queryData *querydata.QueryData
	resource  *resource.Resource
	transport *http.Transport
}

func (i instance) Dispose() {
	i.transport.CloseIdleConnections()
}

type singleInstance struct {
	instance instancemgmt.Instance
	err      error
}

func (s singleInstance) Get(context.Context, backend.PluginContext) (instancemgmt.Instance, error) {
	return s.instance, s.err
}

type ExtendOptions func(ctx context.Context, settings backend.DataSourceInstanceSettings, clientOpts *sdkhttpclient.Options, log log.Logger) error

const searchResponseLimitBytes int64 = 100 * 1024 * 1024

func NewService(httpClientProvider *sdkhttpclient.Provider, plog log.Logger, extendOptions ExtendOptions) *Service {
	if httpClientProvider == nil {
		httpClientProvider = sdkhttpclient.NewProvider()
	}
	return &Service{
		im:     datasource.NewInstanceManager(newInstanceSettings(httpClientProvider, plog, extendOptions)),
		logger: plog,
	}
}

// NewServiceFactory returns a constructor for a Service that serves one data source, for a caller that keeps one
// instance per data source, such as datasource.Manage. If the settings do not build, the Service returns the error.
func NewServiceFactory(httpClientProvider *sdkhttpclient.Provider, plog log.Logger, extendOptions ExtendOptions) func(context.Context, backend.DataSourceInstanceSettings) *Service {
	if httpClientProvider == nil {
		httpClientProvider = sdkhttpclient.NewProvider()
	}
	newInstance := newInstanceSettings(httpClientProvider, plog, extendOptions)
	return func(ctx context.Context, settings backend.DataSourceInstanceSettings) *Service {
		i, err := newInstance(ctx, settings)
		return &Service{im: singleInstance{instance: i, err: err}, logger: plog}
	}
}

// Dispose closes the idle connections of a Service that NewServiceFactory built.
func (s *Service) Dispose() {
	if si, ok := s.im.(singleInstance); ok {
		if d, ok := si.instance.(instancemgmt.InstanceDisposer); ok {
			d.Dispose()
		}
	}
}

func newInstanceSettings(httpClientProvider *sdkhttpclient.Provider, log log.Logger, extendOptions ExtendOptions) datasource.InstanceFactoryFunc {
	return func(ctx context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
		// Parsed once and shared for consumers below.
		jsonData, err := models.ParsePromOptions(settings)
		if err != nil {
			return nil, fmt.Errorf("error reading settings: %v", err)
		}

		// Creates a http roundTripper.
		opts, err := client.CreateTransportOptions(
			ctx,
			settings,
			jsonData.HTTPMethod,
			string(jsonData.CustomQueryParameters),
			float64(jsonData.MaxSamplesProcessedWarningThreshold),
			float64(jsonData.MaxSamplesProcessedErrorThreshold),
			bool(jsonData.QueryStatsEnabled),
			log,
		)
		if err != nil {
			return nil, fmt.Errorf("error creating transport options: %v", err)
		}

		if extendOptions != nil {
			err = extendOptions(ctx, settings, opts, log)
			if err != nil {
				return nil, fmt.Errorf("error extending transport options: %v", err)
			}
		}

		// http.Client.CloseIdleConnections cannot reach the transport through the SDK's middleware chain until
		// https://github.com/grafana/grafana-plugin-sdk-go/pull/1853 ships.
		var transport *http.Transport
		configureTransport := opts.ConfigureTransport
		opts.ConfigureTransport = func(o sdkhttpclient.Options, t *http.Transport) {
			transport = t
			if configureTransport != nil {
				configureTransport(o, t)
			}
		}

		httpClient, err := httpClientProvider.New(*opts)
		if err != nil {
			return nil, fmt.Errorf("error creating http client: %v", err)
		}

		featureToggles := backend.GrafanaConfigFromContext(ctx).FeatureToggles()

		// New version using custom client and better response parsing
		qd, err := querydata.New(
			httpClient,
			settings,
			jsonData.HTTPMethod,
			jsonData.QueryTimeout,
			jsonData.TimeInterval,
			log,
			featureToggles,
		)
		if err != nil {
			return nil, err
		}

		// Resource call management using new custom client same as querydata
		r, err := resource.New(httpClient, settings, jsonData.HTTPMethod, log)
		if err != nil {
			return nil, err
		}

		return instance{
			queryData: qd,
			resource:  r,
			transport: transport,
		}, nil
	}
}

func (s *Service) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	if len(req.Queries) == 0 {
		err := fmt.Errorf("query contains no queries")
		instrumentation.UpdateQueryDataMetrics(err, nil)
		return &backend.QueryDataResponse{}, err
	}

	i, err := s.getInstance(ctx, req.PluginContext)
	if err != nil {
		instrumentation.UpdateQueryDataMetrics(err, nil)
		return nil, err
	}

	qd, err := i.queryData.Execute(ctx, req)
	instrumentation.UpdateQueryDataMetrics(err, qd)

	return qd, err
}

func (s *Service) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	i, err := s.getInstance(ctx, req.PluginContext)
	if err != nil {
		return err
	}

	switch {
	case strings.HasPrefix(strings.TrimPrefix(req.Path, "/"), "api/v1/search/"):
		// Search responses are NDJSON streams and must bypass the catch-all
		// Execute path, which buffers and decodes the complete response.
		ctx = sdkhttpclient.WithResponseLimit(ctx, searchResponseLimitBytes)
		return i.resource.ExecuteSearch(ctx, req, sender)
	case strings.EqualFold(req.Path, "suggestions"):
		resp, err := i.resource.GetSuggestions(ctx, req)
		if err != nil {
			return err
		}
		return sender.Send(resp)
	}

	resp, err := i.resource.Execute(ctx, req)
	if err != nil {
		return err
	}

	return sender.Send(resp)
}

func (s *Service) getInstance(ctx context.Context, pluginCtx backend.PluginContext) (*instance, error) {
	i, err := s.im.Get(ctx, pluginCtx)
	if err != nil {
		return nil, err
	}
	in := i.(instance)
	return &in, nil
}
