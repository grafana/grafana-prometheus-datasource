---
'promlib': patch
---

Remove the shared-manager NewService API. Consumers must use NewDatasourceService and manage datasource lifecycles in the host.
