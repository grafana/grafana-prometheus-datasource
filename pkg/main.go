package main

import (
	"os"

	"github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	promds "github.com/grafana/grafana-prometheus-datasource/pkg/datasource"
)

func main() {
	if err := datasource.Manage("prometheus", promds.NewDatasource, datasource.ManageOpts{}); err != nil {
		log.DefaultLogger.Error(err.Error())
		os.Exit(1)
	}
}
