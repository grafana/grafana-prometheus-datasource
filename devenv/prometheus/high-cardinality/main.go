package main

import (
	"fmt"
	"log"
	// #nosec G404 -- This synthetic exporter only varies non-sensitive metric labels.
	"math/rand/v2" // nosemgrep: math-random-used
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func randomValue(values []string) string {
	return values[rand.IntN(len(values))]
}

func main() {
	dimensions := []string{
		"cluster",
		"namespace",
		"pod",
		"container",
		"method",
		"address",
		"extra_label_name1",
		"extra_label_name2",
		"extra_label_name3",
		"extra_label_name4",
		"extra_label_name5",
		"extra_label_name6",
	}

	requests := promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "fakedata_highcard_http_requests_total",
		Help: "A high cardinality counter.",
	}, dimensions)

	clusters := []string{"prod-uk1", "prod-eu1", "prod-uk2", "prod-eu2", "prod-uk3", "prod-eu3", "prod-uk4", "prod-eu4", "prod-uk5", "prod-eu5"}
	namespaces := []string{"default", "kube-api", "kube-system", "kube-public", "kube-node-lease", "kube-ingress", "kube-logging", "kube-metrics", "kube-monitoring", "kube-network", "kube-storage"}
	methods := []string{"GET", "POST", "DELETE", "PUT", "PATCH"}
	addresses := []string{"/", "/api", "/api/dashboard", "/api/dashboard/:uid", "/api/dashboard/:uid/overview", "/api/dashboard/:uid/overview/:id", "/api/dashboard/:uid/overview/:id/summary", "/api/dashboard/:uid/overview/:id/summary/:type", "/api/dashboard/:uid/overview/:id/summary/:type/:subtype", "/api/dashboard/:uid/overview/:id/summary/:type/:subtype/:id"}

	http.Handle("/metrics", promhttp.Handler())
	http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("high-cardinality exporter"))
	})

	go func() {
		for {
			requests.WithLabelValues(
				randomValue(clusters),
				randomValue(namespaces),
				"default",
				"container",
				randomValue(methods),
				randomValue(addresses),
				"default",
				"default",
				"default",
				"default",
				"default",
				"default",
			).Inc()
			time.Sleep(time.Millisecond)
		}
	}()

	fmt.Println("High-cardinality exporter listening on :9111")
	// #nosec G114 -- This local devenv metrics endpoint has no sensitive traffic.
	log.Fatal(http.ListenAndServe(":9111", nil)) // nosemgrep: local devenv only
}
