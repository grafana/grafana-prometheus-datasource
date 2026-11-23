---
'promlib': patch
---

Add `querydata.RejectOversizedReply`, which fails a query reply that is too large to send from a plugin process to Grafana, before it is encoded. promlib does not call it, so code that runs promlib inside the Grafana server does not change.
