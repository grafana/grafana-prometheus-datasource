package resource

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGetSelectorsExtendedRanges(t *testing.T) {
	for _, modifier := range []string{"anchored", "smoothed"} {
		t.Run(modifier, func(t *testing.T) {
			selectors, err := getSelectors(`sum(rate(http_requests_total{job="api"}[5m] ` + modifier + `))`)
			require.NoError(t, err)
			require.Equal(t, []string{"http_requests_total"}, selectors)
		})
	}
}
