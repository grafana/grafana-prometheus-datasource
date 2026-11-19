---
'promlib': patch
---

Update grafana-plugin-sdk-go to v0.302.0, which lowers the memory that encoding large query responses holds. Remove `ValidateAdmission`, `MutateAdmission` and `ConvertObjects` from `Service`, because the SDK no longer has the experimental admission and conversion hooks.
