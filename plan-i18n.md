# Prometheus Datasource — i18n Plan

## Architecture (How It All Fits Together)

There are two things in this repo, and they share one i18n namespace:

```
grafana-prometheus-datasource/
├── i18next.config.ts                ← repo root (scans both src/ and package) ✓
├── crowdin.yml                      ← Crowdin source mapping ✓
├── packages/grafana-prometheus/
│   ├── src/locales/<19 langs>/grafana-prometheus.json  ← translations ✓
│   └── src/loadResources.ts         ← lazy-loads locale JSON at runtime ✓
└── src/
    ├── module.ts                    ← calls initPluginTranslations(id, [loadResources]) ✓
    ├── plugin.json                  ← lists all 19 languages ✓
    └── configuration/
        ├── ConfigEditor.tsx         ← hardcoded strings (follow-up PRs)
        └── HttpSettings.tsx         ← hardcoded strings (follow-up PRs)
```

**Key point:** ONE namespace `grafana-prometheus`, ONE Crowdin project at repo level. The package needs no Crowdin project ID — that lives in GitHub repo secrets.

**How consumers work:**

| Consumer | What they do | What they get |
|---|---|---|
| `grafana-prometheus-datasource` (this repo) | Calls `initPluginTranslations(id, [loadResources])` | All shared UI strings translated |
| `grafana-amazonprometheus-datasource` | Imports `loadResources` from `@grafana/prometheus` | Shared UI strings for free; own plugin strings separate |
| `azure-prometheus-datasource` | Same as above | Same as above |

---

## Status

### Done (merged in branch `ismail/i18n-support`)

| Commit | What |
|---|---|
| `a442f99` | Moved `i18next.config.ts` to repo root with explicit paths for both `src/` and package; moved `i18next-cli` dep and `i18n-extract` script to root `package.json` |
| `f613711` | Fixed `src/plugin.json` languages from `["en-US", "es-ES"]` → all 19 locales |
| `1925a28` | Added `.github/workflows/i18n-verify.yml` using the shared grafana-github-actions workflow |
| `efbddc6` | Added `@grafana/i18n` ESLint rules to `eslint.config.mjs` (`no-untranslated-strings: warn`, `no-translation-top-level: error`) |
| `9328d9e` | Added `crowdin.yml` + 4 Crowdin workflows (upload, download, create-tasks, verify). Download and create-tasks schedules are **commented out** pending bulk import. `crowdin_project_id` is placeholder `0`. |

### Blocked — needs you

**Step A — Create Crowdin project (manual, ~5 min)**
1. Go to [grafana-github-actions → crowdin-create-project](https://github.com/grafana/grafana-github-actions/actions/workflows/crowdin-create-project.yml)
2. Run the workflow with project name: `grafana-prometheus-datasource`
3. Note the **project ID** from the action output

**Step B — Add repo secrets + update project ID**

Once you have the project ID and `CROWDIN_PERSONAL_TOKEN`:
- Tell me the project ID — I'll replace the `crowdin_project_id: 0` placeholder in the 3 Crowdin workflow files and commit
- I can also set the GitHub secrets via `gh secret set` if you give me the values

**Step C — Pair with Josh Hunt (bulk import existing translations)**
- The 19 existing locale files must be imported into Crowdin before enabling the schedules
- Only after this: uncomment the `schedule:` blocks in `i18n-crowdin-download.yml` and `i18n-crowdin-create-tasks.yml`
- **Do NOT run `i18n-crowdin-create-tasks` manually or by schedule until this is done**

---

## Out of Scope (Follow-up PRs — After This Branch Merges)

String wrapping is handled after the infrastructure PR merges:

- **PR A** — `src/configuration/ConfigEditor.tsx` + `HttpSettings.tsx` (~4 strings)
- **PR B onwards** — `packages/grafana-prometheus/src/` files (~18 files), one area at a time

The `no-untranslated-strings: warn` ESLint rule will surface these without blocking.
Once all strings are wrapped, escalate the rule from `warn` → `error`.

---

## References

- [Grafana Plugin i18n docs](https://grafana.com/developers/plugin-tools/how-to-guides/plugin-internationalization)
- Internal runbook: _Setting up translations for a plugin_ (wiki.grafana-ops.net — requires login)
- Crowdin contacts: Ash Harrison (runbook author), Josh Hunt (Frontend Platform)
- Reference plugin: [azure-data-explorer-datasource](https://github.com/grafana/azure-data-explorer-datasource) (fully translated, workflows adapted from here)
