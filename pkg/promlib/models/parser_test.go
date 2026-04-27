package models

import (
	"fmt"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseExpr(t *testing.T) {
	tests := []struct {
		name      string
		expr      string
		expected  string
		expectErr bool
	}{
		{
			name:     "simple metric",
			expr:     `http_requests_total`,
			expected: `http_requests_total`,
		},
		{
			name:     "metric with label matchers",
			expr:     `http_requests_total{job="prometheus",method="get"}`,
			expected: `http_requests_total{job="prometheus",method="get"}`,
		},
		{
			name:     "rate over range",
			expr:     `rate(http_requests_total[5m])`,
			expected: `rate(http_requests_total[5m])`,
		},
		{
			name:     "aggregation with by clause",
			expr:     `sum by(status) (rate(http_requests_total{job="api"}[5m]))`,
			expected: `sum by(status) (rate(http_requests_total{job="api"}[5m]))`,
		},
		{
			name:      "invalid expression",
			expr:      `{`,
			expectErr: true,
		},
		{
			name:      "empty expression",
			expr:      ``,
			expectErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			expr, err := ParseExpr(tt.expr)
			if tt.expectErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.expected, expr.String())
		})
	}
}

// TestParseExprPoolReuse verifies that borrowing the same parser instance
// multiple times from the pool never produces stale or corrupted output.
func TestParseExprPoolReuse(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{`http_requests_total`, `http_requests_total`},
		{`rate(http_requests_total[5m])`, `rate(http_requests_total[5m])`},
		{`sum by(job) (http_requests_total)`, `sum by(job) (http_requests_total)`},
	}

	for i := 0; i < 20; i++ {
		for _, c := range cases {
			got, err := ParseExpr(c.input)
			require.NoError(t, err)
			require.Equal(t, c.expected, got.String())
		}
	}
}

// TestParseExprErrorDoesNotCorruptPool verifies that a failed parse returns
// the parser to the pool in a state where subsequent calls still work correctly.
func TestParseExprErrorDoesNotCorruptPool(t *testing.T) {
	_, err := ParseExpr(`{invalid`)
	require.Error(t, err)

	got, err := ParseExpr(`http_requests_total`)
	require.NoError(t, err)
	require.Equal(t, `http_requests_total`, got.String())
}

// TestParseExprConcurrent runs many goroutines simultaneously to verify pool
// safety under concurrency. Run with -race to surface any data races.
func TestParseExprConcurrent(t *testing.T) {
	const goroutines = 50
	errs := make(chan error, goroutines)

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			got, err := ParseExpr(`rate(http_requests_total{job="api"}[5m])`)
			if err != nil {
				errs <- err
				return
			}
			if got.String() != `rate(http_requests_total{job="api"}[5m])` {
				errs <- fmt.Errorf("unexpected result: %s", got.String())
			}
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		require.NoError(t, err)
	}
}
