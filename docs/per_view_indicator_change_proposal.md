# Per-View Indicator Consistency — Change Record (AS-BUILT)

> **Status: IMPLEMENTED 2026-05-29.** Final decisions:
> Per-view photo fix reads the per-view crop and never the full panorama.
> Recommendation eligibility is **data-driven** (indicator `status` in the
> codebook), not a hardcoded id list. The originally-flagged indicators were
> re-split by a simple rule — **computable from a (per-view) image → keep &
> show (marked); needs non-image data → hide as future-development.**

## 0. Background

Two problems behind "three-view pipeline is slow / results don't belong to any
view":

1. **Input bug.** Photo-reading calculators read `img.filepath` — the full
   **2048×1024** equirectangular panorama — for *every* view, while the masks
   are per-view **512×313** crops. A "left view" texture/colour number was
   actually computed over the whole panorama.
2. **Definitional gap.** Some indicators are *named/defined* over a panoramic /
   hemispherical / simulated field of view; computed on a 120° crop they are no
   longer the metric the name implies (or can't be computed at all).

## 1. Part A — per-view input fix (DONE)

**File:** `packages/backend/app/api/routes/analysis.py` (per-image loop, ~L1781).

```python
# was: photo_path = img.filepath
photo_path = img.mask_filepaths.get("original")
```

- `original` is the current view's crop (left/front/right) for panorama
  projects and the single-view copy for non-panorama. Distinct, 512×313,
  matches the masks.
- **No `img.filepath` fallback**: verified every vision-processed image has
  `original` (0 missing across all 4 projects), so the full panorama is never
  read. If it were ever absent, photo-reading calculators degrade to the
  semantic map internally — never to the panorama.
- Central: covers all 20 photo-reading calculators; non-panorama unchanged.

## 2. Part B — data-driven recommendation eligibility (DONE)

No hardcoded id list. Single source of truth =
`Encoding_Dictionary.json → A_indicators[id].status`, surfaced via
**`KnowledgeBase.is_recommendable()`**: recommendable ⇔ present in the codebook
AND `status == "active"` (missing status defaults to active); excluded ⇔
`status` ∈ {`future_development`, `unsupported`} OR absent from the codebook
(phantom ids like `IND_GVI_ANG`). Both `recommend_indicators` and
`recommend_indicators_stream` use it (the streaming path previously had no
filter — a latent leak, now fixed).

### The re-split (the rule: image-computable → show; needs non-image data → hide)

**KEPT & SHOWN (re-enabled `status: active`, with an honest mark):**

| ID | Mark (`view_scope`) | Why it can stay |
|---|---|---|
| `IND_SVF` | `per_view_directional` | plain sky-pixel ratio (`Sum(Sky)/Sum(Total)`); fully image-computable. Marked as a per-view directional ratio, not the hemispherical SVF |
| `IND_TVF` | `per_view_directional` | plain tree-pixel ratio; same as above |
| `IND_SQI` | `composite` | composite of sub-indices; retained per request — output only as good as its available sub-indices |
| `IND_HPS` | `composite` | composite of 5 sub-scores; retained per request |

> SVF/TVF needed **no code change** — their calculators are already plain
> `ratio` calculators reading the (per-view) semantic map. The only change is
> the honest definition mark + re-enabling them.

**HIDDEN (`status: future_development`, 7) — need data a per-view image can't provide:**

| ID | Missing input |
|---|---|
| `IND_SVF_DEC` | DSM / building-model simulation |
| `IND_ENC_BLD` | DSM simulation |
| `IND_ENC_TRE` | DSM simulation |
| `IND_VSG_BLK` | surrounding street network |
| `IND_SHA` | sun-path (date/time/location) + fisheye skydome |
| `IND_SVF_CHG` | Δ between two adjacent points (spatial sequence, not one image) |
| `IND_OVH_SHL` | panorama top/bird's-eye view — pipeline crops L/F/R only; **top crop NOT being added** (per decision) |

## 3. Annotation (DONE) — single status vocabulary

`status` ∈ {`active`, `future_development`} drives recommendation; `view_scope`
(`per_view_directional` / `composite`) + `view_note` carry the honest meaning.

| Surface | File | State |
|---|---|---|
| Knowledge base (runtime source of truth) | `data/knowledge_base/Encoding_Dictionary.json → A_indicators` | SVF, TVF, SQI, HPS → `active` + marks; SVF_CHG, SVF_DEC, ENC_BLD, OVH_SHL, VSG_BLK, SHA → `future_development` (`IND_ENC_TRE` is not in this file) |
| Indicator library (documentation) | `data/A_indicators.xlsx` (Indicators_91) | 7 rows `future_development`, the rest `active` (incl. the 4 kept) |

`SVCs_P_Evidence.json` / `I_SVCs_Operations.json` reference indicators by id and
inherit the status. Calculator `INDICATOR` dicts unchanged.

## 4. Decisions recorded

- Image-computable indicators are **kept and shown** with an honest mark, not
  excluded (SVF/TVF directional; SQI/HPS composite).
- Only indicators needing **non-image data** (DSM, sun-path, street network) or
  a **view the pipeline doesn't produce** (panorama top crop) are hidden.
- `IND_OVH_SHL`: top-view crop **not** being added → stays hidden.
- Exclusion governs only the recommendation candidate pool; manual selection of
  any indicator is still allowed.

## 5. Verification

- `is_recommendable` simulated against the real KB: of 88 evidence-referenced
  indicators, **82 recommendable / 6 excluded** (ENC_BLD, OVH_SHL, SHA,
  SVF_CHG, SVF_DEC, VSG_BLK — the in-evidence subset of the 7 hidden); SVF, TVF,
  SQI, HPS confirmed recommendable again.
- xlsx + KB re-read clean; `gemini_client` calls `is_recommendable` in all 3
  spots; no leftover hardcoded sets.
- **Operational:** restart the backend so it reloads `Encoding_Dictionary.json`
  (the KB is cached at load) — otherwise the status changes won't take effect.
- **Caveat:** the sandbox bash mount served stale snapshots of file-tool-edited
  `.py` files, so `py_compile` couldn't run there; edits verified via the
  authoritative file tool. Run `python -m app.main` / `npm run build` locally to
  confirm.
