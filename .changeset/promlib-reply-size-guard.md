---
'promlib': patch
---

Fail a query reply that is too large to send to Grafana before it is encoded, with an error that names the limit. Such a reply used to fail when the plugin sent it, after it had been built in memory in full. Set `[plugin.prometheus] reply_size_guard = false` (`GF_PLUGIN_REPLY_SIZE_GUARD=false`) to turn the check off.
