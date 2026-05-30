# Paper and Repository Alignment

Last checked: 2026-05-17.

This document is the repository-side alignment note for:

- `SceneRxAI_polished1-28_v3edits_v5.docx`
- `SceneRX-AI.svg`
- `SceneRx-AI.pdf`
- the current `scenerx` implementation
- the sibling `AI_City_View` vision service

It should be treated as the local source of truth when manuscript text or
figures describe the software implementation.

## Repository Relationship

`scenerx` is the application repository. `AI_City_View` is a sibling vision
service in this workspace, not a subdirectory of `scenerx`.

At runtime, `scenerx` calls the vision service over HTTP through
`VISION_API_URL` / `vision_api_url`:

- frontend-visible routes: `/api/vision/analyze`,
  `/api/vision/analyze/panorama`, `/api/vision/analyze/project-image`, and
  `/api/vision/analyze/project-image/panorama`
- backend proxy: `packages/backend/app/api/routes/vision.py`
- backend HTTP client: `packages/backend/app/services/vision_client.py`
- upstream service endpoints: `AI_City_View/server.py` exposes `/analyze` and
  `/analyze/panorama`

Therefore the correct architectural phrasing is: `AI_City_View` is the
external/sibling vision service used by SceneRx. It is not literally contained
inside the `scenerx` repository tree in this workspace.

## Canonical Stage Mapping

| Manuscript / figure stage | Current code stage | Implementation files | Strict wording |
|---|---|---|---|
| Project definition and context | Project setup / project query | `packages/frontend/src/pages/ProjectWizard.tsx`, `packages/backend/app/models/project.py`, `packages/backend/app/api/routes/projects.py`, `packages/backend/app/services/project_context_builder.py` | Project metadata, design brief, climate/urban-form context, performance dimensions, subdimensions, zones, and uploaded images are captured before recommendation and analysis. |
| Evidence-based indicator matching | Stage 1 | `packages/backend/app/services/gemini_client.py`, `packages/backend/app/services/knowledge_base.py`, `packages/backend/app/services/transferability.py` | Python builds evidence and transferability context; the LLM acts as Ranker/Selector for indicator recommendation. Do not describe this as two independent Gemini agents. |
| Vision analysis | Stage 2 | `../AI_City_View/server.py`, `../AI_City_View/pipeline/stage2_ai_inference.py`, `../AI_City_View/pipeline/stage4_intelligent_fmb.py`, `../AI_City_View/pipeline/stage6_generate_images.py`, `packages/backend/app/services/vision_client.py` | OneFormer ADE20K semantic segmentation and Depth Anything V3 depth estimation are run per view. The HTTP service default is `depth-anything/DA3METRIC-LARGE`; the CLI/config fallback default is `depth-anything/DA3NESTED-GIANT-LARGE-1.1`. |
| Metric calculation and aggregation | Stage 2.5 | `packages/backend/app/services/metrics_calculator.py`, `packages/backend/app/services/metrics_aggregator.py`, `packages/backend/data/metrics_code/` | Indicator calculators operate on saved masks/images, then aggregate per zone and layer. |
| Zone diagnostics | Stage 3 | `packages/backend/app/services/zone_analyzer.py` | The implementation computes descriptive z-scores, percentiles, CV, Shapiro-Wilk, Kruskal-Wallis, and correlation diagnostics. The correlation implementation uses Pearson matrices; data-quality metadata may label preferred Pearson/Spearman interpretation based on normality. |
| Diagnosis and strategy synthesis | Stage 3 / design stage | `packages/backend/app/services/design_engine.py` | Agent A is the Spatial Diagnostician. It generates diagnosis and IOM queries. Deterministic Python code matches IOM records. Agent B is the Strategy Synthesiser. |
| Narrative report | AI report stage | `packages/backend/app/services/report_service.py` | Agent C is the Report Writer and turns stored Stage 1-3 outputs into a traceable markdown report. There is no Agent D in the current repository. |

## Vision Model Facts

The current vision stack is not a parallel two-model fusion between a
segmentation model and a separate sky model.

- Semantic backend default: `oneformer_ade20k`
- OneFormer model id: `shi-labs/oneformer_ade20k_swin_large`
- Depth backend: Depth Anything V3
- HTTP service depth default: `depth-anything/DA3METRIC-LARGE`
- CLI/config fallback depth default:
  `depth-anything/DA3NESTED-GIANT-LARGE-1.1`
- Single-image upstream endpoint: `/analyze`
- Panorama upstream endpoint: `/analyze/panorama`
- Panorama mode crops a panorama into `left`, `front`, and `right` views, then
  analyzes each view.
- FMB metric thresholds default to foreground `< 10 m`, middleground
  `10-50 m`, and background `>= 50 m` plus sky.
- Sky handling uses DA3 sky output and/or semantic fallback logic in the
  pipeline, then forces sky/background handling during FMB. Do not describe the
  implementation as an explicit Boolean-OR or pixel-level OR fusion step.

## Vision Outputs

`AI_City_View/server.py` serializes 23 Stage-6 core image layers plus optional
diagnostic layers:

- core images: `original`, `semantic_map`, `depth_map`, `openness_map`,
  `fmb_map`, `foreground_map`, `middleground_map`, `background_map`,
  `semantic_foreground`, `semantic_middleground`, `semantic_background`,
  `depth_foreground`, `depth_middleground`, `depth_background`,
  `openness_foreground`, `openness_middleground`, `openness_background`,
  `original_foreground`, `original_middleground`, `original_background`,
  `fmb_foreground`, `fmb_middleground`, `fmb_background`
- optional/diagnostic images: `sky_mask`, `semantic_raw`
- metadata may include `depth_stats` and `fmb_thresholds`

Use "23 core image layers plus optional `sky_mask` and `semantic_raw`" rather
than "20 PNG layers" or "25 raster layers."

## LLM Runtime Facts

The current repository uses an abstract LLM client with multiple providers:

- provider setting: `llm_provider`
- default provider: `gemini`
- default Gemini model: `gemini-2.5-flash`
- supported providers: Gemini, OpenAI, Anthropic Claude, DeepSeek
- provider factory: `packages/backend/app/services/llm_client.py`

Manuscript and figure text should say "provider LLM" or "configured LLM
backend" for runtime stages. Do not claim that runtime inference depends on a
fixed `Gemini 3.1 Pro` model.

## Knowledge Base Facts

The current bundled knowledge base contains:

- `SVCs_P_Evidence.json`: 342 records, 88 unique `IND_*` indicators
- `I_SVCs_Operations.json`: 342 operation records, 88 unique `IND_*`
  indicators
- `Transferability_Context.json`: 137 records
- `A_indicators.xlsx`: 91 indicator rows in the `Indicators_91` sheet

Figure or manuscript text should use these repository counts unless the data
files change.

## Frontend Facts

The current frontend stack is:

- React 19
- TypeScript
- Vite 7
- Chakra UI v2
- TanStack React Query v5
- Zustand v5

Do not list `@tanstack/react-form` as part of the current implementation unless
that package is added to `packages/frontend/package.json`.

## Legacy Claims To Avoid

The following claims are not aligned with the current repository:

- `AI_City_View` is contained inside the `scenerx` repo tree.
- The vision stack is a dual-model, parallel, Boolean-OR fusion pipeline.
- The active semantic stack is `SAM 2.1 + LangSAM` by default.
- The active API route is `/ai-city-view/infer`.
- The output bundle is exactly 20 PNG layers or 25 raster layers.
- Runtime report/strategy generation is fixed to `Gemini 3.1 Pro`.
- There is an Agent D.
- The frontend uses `@tanstack/react-form`.
