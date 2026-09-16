package resource

import (
	"regexp"
	"slices"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// allowedResourcePathPatterns are the resource paths callers may reach
// through CallResource; anything else is rejected before being proxied.
var allowedResourcePathPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^api/v1/query$`),
	regexp.MustCompile(`^api/v1/query_range$`),
	regexp.MustCompile(`^api/v1/query_exemplars$`),
	regexp.MustCompile(`^api/v1/series$`),
	regexp.MustCompile(`^api/v1/labels$`),
	regexp.MustCompile(`^api/v1/label/[^/]+/values$`),
	regexp.MustCompile(`^api/v1/metadata$`),
	regexp.MustCompile(`^api/v1/rules$`),
	regexp.MustCompile(`^api/v1/status/buildinfo$`),
	regexp.MustCompile(`^api/v1/search/(metric_names|label_names|label_values)$`),
}

// isAllowedResourcePath returns whether a resource path request should be allowed
// also rejects percent-escapes, empty segments, and
// "." / ".." segments, which could otherwise bypass the allowlist match.
func isAllowedResourcePath(path string) bool {
	backend.Logger.Warn("Checking allowlist")
	trimmed := strings.TrimPrefix(path, "/")
	if trimmed == "" {
		return false
	}

	// by this point we "know the path should have already been decoded and it
	// cannot contain "%"
	if strings.Contains(trimmed, "%") {
		return false
	}

	for segment := range strings.SplitSeq(trimmed, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}

	return slices.ContainsFunc(allowedResourcePathPatterns, func(re *regexp.Regexp) bool {
		return re.MatchString(trimmed)
	})
}
