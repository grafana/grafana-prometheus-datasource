// TODO: Remove this file once @grafana/data devDependency is bumped to >=13.0.0.
// The published @grafana/data@12.4.2 predates the dashboardUnifiedDrilldownControls
// feature toggle. This augmentation fills the gap until we depend on a version that
// includes it natively in FeatureToggles.
import '@grafana/data';

declare module '@grafana/data' {
  interface FeatureToggles {
    dashboardUnifiedDrilldownControls?: boolean;
  }
}
