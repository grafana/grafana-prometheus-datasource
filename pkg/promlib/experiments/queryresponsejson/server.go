package queryresponsejson

import (
	"fmt"
	"net/http"
	"os"
)

const queryRangePath = "/api/v1/query_range"

// NewQueryRangeHandler returns a fixture-backed Prometheus query_range handler.
// It serves the supplied response unchanged for every valid GET or POST request.
func NewQueryRangeHandler(fixture string) (http.Handler, error) {
	info, err := os.Stat(fixture)
	if err != nil {
		return nil, fmt.Errorf("stat fixture: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("fixture %q is not a regular file", fixture)
	}

	mux := http.NewServeMux()
	mux.HandleFunc(queryRangePath, func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodPost {
			writer.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
			http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		http.ServeFile(writer, request, fixture)
	})
	return mux, nil
}
