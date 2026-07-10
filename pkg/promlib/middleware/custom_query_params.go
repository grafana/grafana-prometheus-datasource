package middleware

import (
	"net/http"
	"net/url"
	"strconv"

	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

const (
	customQueryParametersMiddlewareName = "prom-custom-query-parameters"
	warningThresholdKey                 = "max_samples_processed_warning_threshold"
	errorThresholdKey                   = "max_samples_processed_error_threshold"
)

// CustomQueryParameters returns a middleware that appends user-configured custom
// query parameters and max-samples-processed thresholds to outgoing Prometheus
// requests. Configuration is read from the typed PromOptions parsed from the
// datasource jsonData.
func CustomQueryParameters(logger log.Logger, jsonData *models.PromOptions) sdkhttpclient.Middleware {
	return sdkhttpclient.NamedMiddlewareFunc(customQueryParametersMiddlewareName, func(opts sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		if jsonData == nil {
			return next
		}

		customQueryParams := jsonData.CustomQueryParameters
		warnVal := jsonData.MaxSamplesProcessedWarningThreshold
		errVal := jsonData.MaxSamplesProcessedErrorThreshold

		if customQueryParams == "" && warnVal == 0 && errVal == 0 {
			return next
		}

		values := url.Values{}
		if customQueryParams != "" {
			parsed, err := url.ParseQuery(customQueryParams)
			if err != nil {
				logger.Error("Failed to parse custom query parameters, skipping middleware", "error", err)
				return next
			}
			values = parsed
		}

		// Threshold fields are explicit settings and override matching custom query parameters.
		if warnVal > 0 {
			values.Set(warningThresholdKey, strconv.FormatFloat(warnVal, 'f', -1, 64))
		}
		if errVal > 0 {
			values.Set(errorThresholdKey, strconv.FormatFloat(errVal, 'f', -1, 64))
		}

		return sdkhttpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			q := req.URL.Query()
			for k, keyValues := range values {
				for _, value := range keyValues {
					q.Add(k, value)
				}
			}
			req.URL.RawQuery = q.Encode()

			return next.RoundTrip(req)
		})
	})
}
