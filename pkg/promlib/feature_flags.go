package promlib

import (
	"cmp"
	"context"
	"maps"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/open-feature/go-sdk-contrib/providers/ofrep"
	"github.com/open-feature/go-sdk/openfeature"
	"golang.org/x/sync/singleflight"
)

const flagMimirProtobufResponses = "prometheus.mimir-protobuf-responses"

const (
	ofrepRequestTimeout  = 5 * time.Second
	ofrepDefaultCacheTTL = time.Minute
)

// mimirProtobufResponsesEnabled evaluates flagMimirProtobufResponses for the request's namespace. Any discovery or
// evaluation error turns it off.
func (f *ofrepFlags) mimirProtobufResponsesEnabled(ctx context.Context, logger log.Logger) bool {
	of, err := config.GrafanaConfigFromContext(ctx).OpenFeature()
	// promlib runs only as a standalone plugin, which can call only an OFREP host endpoint without credentials.
	if err != nil || of.ProviderType != "ofrep" {
		return false
	}
	evalCtx := flagEvaluationContext(backend.PluginConfigFromContext(ctx), of.ContextAttrs)
	return f.isEnabled(ctx, logger, of, flagMimirProtobufResponses, evalCtx)
}

// flagEvaluationContext targets the plugin namespace and adds the host's OpenFeature context attributes.
func flagEvaluationContext(pluginCtx backend.PluginContext, hostAttrs map[string]string) openfeature.EvaluationContext {
	attrs := make(map[string]any, len(hostAttrs))
	for k, v := range hostAttrs {
		attrs[k] = v
	}
	return openfeature.NewEvaluationContext(cmp.Or(pluginCtx.Namespace, hostAttrs["namespace"]), attrs)
}

// ofrepFlags evaluates flags against the host's OFREP endpoint and caches each answer for the host's TTL. A failed
// request keeps the previous answer.
type ofrepFlags struct {
	group     singleflight.Group
	mu        sync.Mutex
	providers map[string]*ofrep.Provider
	answers   map[string]ofrepAnswer
}

type ofrepAnswer struct {
	enabled bool
	expires time.Time
}

func newOFREPFlags() *ofrepFlags {
	return &ofrepFlags{providers: map[string]*ofrep.Provider{}, answers: map[string]ofrepAnswer{}}
}

func (f *ofrepFlags) isEnabled(ctx context.Context, logger log.Logger, of config.OpenFeatureConfig, flag string, evalCtx openfeature.EvaluationContext) bool {
	key := flag + "|" + of.URL + "|" + evalCtx.TargetingKey()
	if a, fresh := f.answer(key); fresh {
		return a.enabled
	}
	v, _, _ := f.group.Do(key, func() (any, error) {
		if a, fresh := f.answer(key); fresh {
			return a, nil
		}
		flat := openfeature.FlattenedContext{openfeature.TargetingKey: evalCtx.TargetingKey()}
		maps.Copy(flat, evalCtx.Attributes())
		// Every caller in the TTL window shares the answer, so one caller's cancellation must not fail it.
		detail := f.provider(of.URL).BooleanEvaluation(context.WithoutCancel(ctx), flag, false, flat)

		f.mu.Lock()
		defer f.mu.Unlock()
		a := f.answers[key]
		if detail.Reason == openfeature.ErrorReason {
			logger.Warn("Feature flag evaluation failed", "flag", flag, "error", detail.ResolutionError.Error())
		} else {
			a.enabled = detail.Value
		}
		a.expires = time.Now().Add(cmp.Or(of.CacheTTL, ofrepDefaultCacheTTL))
		f.answers[key] = a
		return a, nil
	})
	a, _ := v.(ofrepAnswer)
	return a.enabled
}

func (f *ofrepFlags) answer(key string) (ofrepAnswer, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.answers[key]
	return a, ok && time.Now().Before(a.expires)
}

func (f *ofrepFlags) provider(url string) *ofrep.Provider {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.providers[url]
	if !ok {
		p = ofrep.NewProvider(url, ofrep.WithTimeout(ofrepRequestTimeout))
		f.providers[url] = p
	}
	return p
}
