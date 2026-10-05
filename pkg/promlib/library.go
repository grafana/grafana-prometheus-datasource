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
	im       instancemgmt.InstanceManager
	instance *instance
	logger   log.Logger
}

type instance struct {
	queryData *querydata.QueryData
	resource  *resource.Resource
	transport *http.Transport
}

type ExtendOptions func(ctx context.Context, settings backend.DataSourceInstanceSettings, clientOpts *sdkhttpclient.Options, log log.Logger) error

const searchResponseLimitBytes int64 = 100 * 1024 * 1024

// NewService creates a service that manages multiple datasource instances for in-process use.
func NewService(httpClientProvider *sdkhttpclient.Provider, plog log.Logger, extendOptions ExtendOptions) *Service {
	return &Service{
		im:     datasource.NewInstanceManager(newInstanceSettings(httpClientProvider, plog, extendOptions)),
		logger: plog,
	}
}

// NewDatasourceService creates a service for one datasource. The caller owns its
// lifecycle and must call Dispose when replacing it. Use this with datasource.Manage,
// which already handles caching and invalidation, to avoid nesting instance managers.
func NewDatasourceService(ctx context.Context, settings backend.DataSourceInstanceSettings, httpClientProvider *sdkhttpclient.Provider, plog log.Logger, extendOptions ExtendOptions) (*Service, error) {
	i, err := newInstance(ctx, settings, httpClientProvider, plog, extendOptions)
	if err != nil {
		return nil, err
	}
	return &Service{instance: i, logger: plog}, nil
}

// Dispose releases the connections owned by a single-datasource service.
// For a service created with NewService, the instance manager disposes its instances.
func (s *Service) Dispose() {
	if s.instance != nil {
		s.instance.Dispose()
	}
}

func (i *instance) Dispose() {
	i.transport.CloseIdleConnections()
}

func newInstanceSettings(httpClientProvider *sdkhttpclient.Provider, log log.Logger, extendOptions ExtendOptions) datasource.InstanceFactoryFunc {
	return func(ctx context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
		return newInstance(ctx, settings, httpClientProvider, log, extendOptions)
	}
}

func newInstance(ctx context.Context, settings backend.DataSourceInstanceSettings, httpClientProvider *sdkhttpclient.Provider, log log.Logger, extendOptions ExtendOptions) (*instance, error) {
	if httpClientProvider == nil {
		httpClientProvider = sdkhttpclient.NewProvider()
	}
	// Parsed once and shared for consumers below.
	jsonData, err := models.ParsePromOptions(settings)
	if err != nil {
		return nil, fmt.Errorf("error reading settings: %v", err)
	}

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

	// SDK middleware wraps the transport without forwarding CloseIdleConnections.
	// Keep the underlying transport so disposal actually closes pooled connections.
	var transport *http.Transport
	configureTransport := opts.ConfigureTransport
	opts.ConfigureTransport = func(options sdkhttpclient.Options, t *http.Transport) {
		if configureTransport != nil {
			configureTransport(options, t)
		}
		transport = t
	}
	initialized := false
	defer func() {
		if !initialized && transport != nil {
			transport.CloseIdleConnections()
		}
	}()

	httpClient, err := httpClientProvider.New(*opts)
	if err != nil {
		return nil, fmt.Errorf("error creating http client: %v", err)
	}

	featureToggles := backend.GrafanaConfigFromContext(ctx).FeatureToggles()

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

	r, err := resource.New(httpClient, settings, jsonData.HTTPMethod, log)
	if err != nil {
		return nil, err
	}

	initialized = true
	return &instance{queryData: qd, resource: r, transport: transport}, nil
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
	if s.instance != nil {
		return s.instance, nil
	}
	i, err := s.im.Get(ctx, pluginCtx)
	if err != nil {
		return nil, err
	}
	return i.(*instance), nil
}
