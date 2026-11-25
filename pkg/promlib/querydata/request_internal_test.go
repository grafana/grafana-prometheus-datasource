package querydata

import (
	"errors"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/require"
)

func TestAddDataResponseKeepsAPluginErrorSource(t *testing.T) {
	panicked := backend.DataResponse{Error: backend.PluginErrorf("panic triggered: boom"), Status: backend.StatusInternal, ErrorSource: backend.ErrorSourcePlugin}
	downstreamErr := errors.New("bad gateway")
	downstream := backend.DataResponse{Error: downstreamErr, Status: backend.StatusBadGateway}

	for name, order := range map[string][]backend.DataResponse{
		"panic first":      {panicked, downstream},
		"downstream first": {downstream, panicked},
	} {
		t.Run(name, func(t *testing.T) {
			dr := &backend.DataResponse{}
			for _, res := range order {
				addDataResponse(&res, dr)
			}
			require.Equal(t, backend.ErrorSourcePlugin, dr.ErrorSource)
			require.True(t, backend.IsPluginError(dr.Error))
			require.ErrorIs(t, dr.Error, downstreamErr)
		})
	}
}
