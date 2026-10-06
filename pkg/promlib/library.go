package promlib

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/client"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/instrumentation"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/resource"
)

type Service struct {
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

// NewDatasourceService creates a service for one datasource whose lifecycle is
// managed by the caller. Call Dispose when the service is no longer needed.
// Datasource settings are fixed at construction; requests do not select an instance.
func NewDatasourceService(ctx context.Context, settings backend.DataSourceInstanceSettings, httpClientProvider *sdkhttpclient.Provider, plog log.Logger, extendOptions ExtendOptions) (*Service, error) {
	if httpClientProvider == nil {
		httpClientProvider = sdkhttpclient.NewProvider()
	}

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
		plog,
	)
	if err != nil {
		return nil, fmt.Errorf("error creating transport options: %v", err)
	}

	if extendOptions != nil {
		err = extendOptions(ctx, settings, opts, plog)
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

	// New version using custom client and better response parsing
	qd, err := querydata.New(
		httpClient,
		settings,
		jsonData.HTTPMethod,
		jsonData.QueryTimeout,
		jsonData.TimeInterval,
		plog,
		featureToggles,
	)
	if err != nil {
		return nil, err
	}

	// Resource call management using new custom client same as querydata
	r, err := resource.New(httpClient, settings, jsonData.HTTPMethod, plog)
	if err != nil {
		return nil, err
	}

	initialized = true
	return &Service{
		instance: &instance{queryData: qd, resource: r, transport: transport},
		logger:   plog,
	}, nil
}

// Dispose closes the idle HTTP connections owned by this datasource.
func (s *Service) Dispose() {
	s.instance.transport.CloseIdleConnections()
}

func (s *Service) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	if len(req.Queries) == 0 {
		err := fmt.Errorf("query contains no queries")
		instrumentation.UpdateQueryDataMetrics(err, nil)
		return &backend.QueryDataResponse{}, err
	}

	qd, err := s.instance.queryData.Execute(ctx, req)
	instrumentation.UpdateQueryDataMetrics(err, qd)

	return qd, err
}

func (s *Service) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	switch {
	case strings.HasPrefix(strings.TrimPrefix(req.Path, "/"), "api/v1/search/"):
		// Search responses are NDJSON streams and must bypass the catch-all
		// Execute path, which buffers and decodes the complete response.
		ctx = sdkhttpclient.WithResponseLimit(ctx, searchResponseLimitBytes)
		return s.instance.resource.ExecuteSearch(ctx, req, sender)
	case strings.EqualFold(req.Path, "suggestions"):
		resp, err := s.instance.resource.GetSuggestions(ctx, req)
		if err != nil {
			return err
		}
		return sender.Send(resp)
	}

	resp, err := s.instance.resource.Execute(ctx, req)
	if err != nil {
		return err
	}

	return sender.Send(resp)
}
