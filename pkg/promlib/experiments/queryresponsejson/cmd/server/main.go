// Command server exposes a generated response at Prometheus's query_range path.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/experiments/queryresponsejson"
)

func main() {
	fixture := flag.String("fixture", "", "generated query_range response fixture")
	listenAddress := flag.String("listen", "127.0.0.1:9090", "HTTP listen address")
	flag.Parse()

	if *fixture == "" {
		fmt.Fprintln(os.Stderr, "-fixture is required")
		os.Exit(2)
	}
	handler, err := queryresponsejson.NewQueryRangeHandler(*fixture)
	if err != nil {
		log.Fatal(err)
	}

	log.Printf("serving %s at http://%s%s", *fixture, *listenAddress, "/api/v1/query_range")
	log.Fatal(http.ListenAndServe(*listenAddress, handler))
}
