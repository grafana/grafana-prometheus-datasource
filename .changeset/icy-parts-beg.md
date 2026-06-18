---
'@grafana/prometheus': patch
---

Export applyModifyQuery as a standalone helper so consumers can apply QueryFixActions without instantiating PrometheusDatasource.
