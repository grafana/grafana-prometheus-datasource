package main

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/prometheus/common/model"
)

func init() {
	model.NameValidationScheme = model.UTF8Validation
	model.NameEscapingScheme = model.ValueEncodingEscaping
}

func main() {
	dimensions := []string{
		"a_legacy_label",
		"label with space",
		"label with 📈",
		"label.with.spaß",
		"instance",
		"job",
		"site",
		"room",
	}

	utf8Metric := promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "a.utf8.metric 🤘",
		Help: "A metric with a UTF-8 name and labels.",
	}, dimensions)
	requests := promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "a_utf8_http_requests_total",
		Help: "A metric with UTF-8 labels.",
	}, dimensions)
	targetInfo := promauto.NewGauge(prometheus.GaugeOpts{
		Name: "target_info",
		Help: "An info metric model for OpenTelemetry.",
		ConstLabels: map[string]string{
			"job":                    "job",
			"instance":               "instance",
			"resource 1":             "1",
			"resource 2":             "2",
			"resource ę":             "e",
			"deployment_environment": "prod",
		},
	})
	labelValues := []string{"legacy", "space", "metrics", "this_is_fun", "instance", "job", "LA-EPI", `"Friends Don't Lie"`}

	http.Handle("/metrics", promhttp.Handler())
	http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("UTF-8 exporter"))
	})

	go func() {
		for {
			utf8Metric.WithLabelValues(labelValues...).Inc()
			requests.WithLabelValues(labelValues...).Inc()
			targetInfo.Set(1)
			time.Sleep(5 * time.Second)
		}
	}()

	fmt.Println("UTF-8 exporter listening on :9112")
	log.Fatal(http.ListenAndServe(":9112", nil))
}
