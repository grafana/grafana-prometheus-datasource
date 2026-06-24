package schema_test

import (
	_ "embed"
	"testing"

	"github.com/grafana/dsconfig/schema"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

//go:embed dsconfig.json
var configSchemaJSON []byte

//go:generate go test -run TestPlugin -generateArtifacts
func TestPlugin(t *testing.T) {
	schema.RunPluginTests(t, schema.PluginUnderTest{
		ID:                "prometheus",
		ConfigSchemaJSON:  configSchemaJSON,
		SettingsJSONModel: models.PrometheusSettings{},
		SecureKeys:        []string{"basicAuthPassword", "tlsCACert", "tlsClientCert", "tlsClientKey"},
	})
}
