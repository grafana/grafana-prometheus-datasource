package promlib

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	schemas "github.com/grafana/schemads"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/client"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/instrumentation"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/resource"
)

type Service struct {
	im     instancemgmt.InstanceManager
	logger log.Logger

	// mailboxes bridges PublishStream (producer) and RunStream (consumer) for the
	// persistent per-session search channels. Keyed by channel path
	// (search/<sessionNonce>); each value coalesces bounded pending work per slot. A
	// Service is created per datasource instance, so this map is already isolated by
	// datasource and tenant.
	mailboxesMu sync.Mutex
	mailboxes   map[string]*searchMailbox

	searchPermits chan struct{}

	lifecycleMu sync.Mutex
	disposed    bool
	nextRunID   uint64
	runCancels  map[uint64]context.CancelFunc
	runWG       sync.WaitGroup
}

type instance struct {
	queryData        *querydata.QueryData
	resource         *resource.Resource
	schemaDatasource *schemas.SchemaDatasource
}

type ExtendOptions func(ctx context.Context, settings backend.DataSourceInstanceSettings, clientOpts *sdkhttpclient.Options, log log.Logger) error

func NewService(httpClientProvider *sdkhttpclient.Provider, plog log.Logger, extendOptions ExtendOptions) *Service {
	if httpClientProvider == nil {
		httpClientProvider = sdkhttpclient.NewProvider()
	}
	return &Service{
		im:            datasource.NewInstanceManager(newInstanceSettings(httpClientProvider, plog, extendOptions)),
		logger:        plog,
		mailboxes:     make(map[string]*searchMailbox),
		searchPermits: make(chan struct{}, maxConcurrentSearches),
		runCancels:    make(map[uint64]context.CancelFunc),
	}
}

// Dispose here tells plugin SDK that plugin wants to clean up resources when a new instance
// created. As soon as datasource settings change detected by SDK old datasource instance will
// be disposed and a new one will be created using NewSampleDatasource factory function.
func (s *Service) Dispose() {
	// Clean up datasource instance resources.
	s.logger.Debug("Disposing the instance...")
	s.lifecycleMu.Lock()
	if !s.disposed {
		s.disposed = true
		for _, cancel := range s.runCancels {
			cancel()
		}
	}
	s.lifecycleMu.Unlock()
	s.runWG.Wait()

	// Drop any per-instance search mailbox state; the replacement instance gets a fresh map.
	s.mailboxesMu.Lock()
	s.mailboxes = make(map[string]*searchMailbox)
	s.mailboxesMu.Unlock()
}

func (s *Service) registerRun(parent context.Context) (context.Context, context.CancelFunc, func(), error) {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	if s.disposed {
		return nil, nil, nil, errors.New("prometheus service is disposed")
	}
	runCtx, cancelRun := context.WithCancel(parent)
	s.nextRunID++
	runID := s.nextRunID
	s.runCancels[runID] = cancelRun
	s.runWG.Add(1)

	var once sync.Once
	release := func() {
		once.Do(func() {
			cancelRun()
			s.lifecycleMu.Lock()
			delete(s.runCancels, runID)
			s.lifecycleMu.Unlock()
			s.runWG.Done()
		})
	}
	return runCtx, cancelRun, release, nil
}

func newInstanceSettings(httpClientProvider *sdkhttpclient.Provider, log log.Logger, extendOptions ExtendOptions) datasource.InstanceFactoryFunc {
	return func(ctx context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
		// Creates a http roundTripper.
		opts, err := client.CreateTransportOptions(ctx, settings, log)
		if err != nil {
			return nil, fmt.Errorf("error creating transport options: %v", err)
		}

		if extendOptions != nil {
			err = extendOptions(ctx, settings, opts, log)
			if err != nil {
				return nil, fmt.Errorf("error extending transport options: %v", err)
			}
		}

		httpClient, err := httpClientProvider.New(*opts)
		if err != nil {
			return nil, fmt.Errorf("error creating http client: %v", err)
		}

		featureToggles := backend.GrafanaConfigFromContext(ctx).FeatureToggles()

		// New version using custom client and better response parsing
		qd, err := querydata.New(httpClient, settings, log, featureToggles)
		if err != nil {
			return nil, err
		}

		// Resource call management using new custom client same as querydata
		r, err := resource.New(httpClient, settings, log)
		if err != nil {
			return nil, err
		}

		// Create schema provider for dsabstraction support
		schemaProvider := resource.NewSchemaProvider(r)
		schemaDs := schemas.NewSchemaDatasource(
			schemaProvider, // SchemaHandler
			schemaProvider, // TablesHandler
			schemaProvider, // ColumnsHandler
			nil,            // TableParameterValuesHandler
			nil,            // ColumnValuesHandler
			nil,            // fallback CallResourceHandler (handled below)
		)

		return instance{
			queryData:        qd,
			resource:         r,
			schemaDatasource: schemaDs,
		}, nil
	}
}

func (s *Service) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	req, schemadsRefIDs := normalizeGrafanaSQLRequest(req)

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

	// Flatten schemads responses from multi-frame time series to single tabular frame.
	if qd != nil && len(schemadsRefIDs) > 0 {
		for refID, dr := range qd.Responses {
			if _, ok := schemadsRefIDs[refID]; ok && dr.Error == nil {
				dr.Frames = flattenTimeSeriesToTabular(dr.Frames)
				qd.Responses[refID] = dr
			}
		}
	}

	return qd, err
}

func (s *Service) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	i, err := s.getInstance(ctx, req.PluginContext)
	if err != nil {
		return err
	}

	// Route schemads requests (abstractionSchema/*) through the SchemaDatasource handler.
	if strings.HasPrefix(req.Path, schemas.BaseResourcePath) {
		return i.schemaDatasource.CallResource(ctx, req, sender)
	}

	switch {
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

// StreamSearch resolves the datasource instance for pluginCtx and performs a streaming
// NDJSON read against the experimental search API, invoking onLine per decoded line.
//
// It intentionally does NOT go through Resource.Execute (which buffers the full body)
// nor through the ResponseLimitMiddleware path, so long NDJSON responses stream
// incrementally without being capped/errored. The instance's resource client carries
// the same instance-settings-built (authenticated) *http.Client used by resource calls.
func (s *Service) StreamSearch(ctx context.Context, pluginCtx backend.PluginContext, endpoint string, params url.Values, onLine func(resource.SearchLine) error) error {
	i, err := s.getInstance(ctx, pluginCtx)
	if err != nil {
		return err
	}
	return i.resource.StreamSearch(ctx, endpoint, params, onLine)
}

func (s *Service) getInstance(ctx context.Context, pluginCtx backend.PluginContext) (*instance, error) {
	i, err := s.im.Get(ctx, pluginCtx)
	if err != nil {
		return nil, err
	}
	in := i.(instance)
	return &in, nil
}
