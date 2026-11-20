package instrumentation

import (
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	pluginRequestCounter = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "grafana",
		Name:      "prometheus_plugin_backend_request_count",
		Help:      "The total amount of prometheus backend plugin requests",
	}, []string{"endpoint", "status", "errorSource"})

	jsonDataLenientTypeCounter = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "grafana",
		Name:      "prometheus_plugin_backend_jsondata_lenient_type_count",
		Help:      "The total amount of datasource jsonData values that did not match their declared type",
	}, []string{"from", "to", "outcome"})
)

const (
	StatusOK    = "ok"
	StatusError = "error"

	EndpointCallResource = string(backend.EndpointCallResource)
	EndpointQueryData    = string(backend.EndpointQueryData)

	PluginSource   = "plugin"
	ExternalSource = "external"
	DatabaseSource = "database"
	NoneSource     = "none"
)

func UpdateQueryDataMetrics(err error, resp *backend.QueryDataResponse) {
	status := backend.RequestStatusFromQueryDataResponse(resp, err).String()
	errorSource := getErrorSource(err, resp)

	pluginRequestCounter.WithLabelValues(EndpointQueryData, status, errorSource).Inc()
}

// UpdateJsonDataLenientTypeMetrics records a jsonData value that didn't match its declared
// type. outcome is "coerced" when the value could still be read, "dropped" when it could not.
func UpdateJsonDataLenientTypeMetrics(fromValueType, toValueType, outcome string) {
	jsonDataLenientTypeCounter.WithLabelValues(fromValueType, toValueType, outcome).Inc()
}

func getErrorSource(err error, resp *backend.QueryDataResponse) string {
	if err != nil {
		return PluginSource
	}

	// If there is different errorSource from the list of responses, we want to return the most severe one.
	// The priority order is: pluginSource > databaseSource > externalSource > noneSource
	var errorSource = NoneSource
	for _, res := range resp.Responses {
		responseErrorSource := getErrorSourceForResponse(res)

		if responseErrorSource == PluginSource {
			return PluginSource
		}

		if responseErrorSource == DatabaseSource {
			errorSource = DatabaseSource
		}

		if responseErrorSource == ExternalSource && errorSource == NoneSource {
			errorSource = ExternalSource
		}
	}

	return errorSource
}

func getErrorSourceForResponse(res backend.DataResponse) string {
	if res.Error != nil {
		if backend.RequestStatusFromError(res.Error) == backend.RequestStatusCancelled {
			return NoneSource
		}
		if res.ErrorSource != backend.ErrorSourceDownstream {
			return PluginSource
		}
		if isAuthStatus(res.Status) {
			return ExternalSource
		}
		return DatabaseSource
	}

	if res.Status >= 500 {
		return DatabaseSource
	}

	if res.Status >= 400 {
		if isAuthStatus(res.Status) {
			return ExternalSource
		}

		return PluginSource
	}

	return NoneSource
}

func isAuthStatus(status backend.Status) bool {
	return status == 401 || status == 402 || status == 403 || status == 407
}
