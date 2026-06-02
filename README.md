# SceneRx — Urban Greenspace Analysis Platform

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Paper](https://img.shields.io/badge/paper-in%20preparation-lightgrey.svg)](#citation)
[![DOI](https://img.shields.io/badge/DOI-pending-lightgrey.svg)](#citation)
[![HF Space](https://img.shields.io/badge/🤗%20Space-live%20demo-blue.svg)](https://huggingface.co/spaces/ZhenGtai123/scenerx)

> Companion code for *SceneRx: An AI-Augmented Pipeline for Urban Greenspace Performance Diagnosis* (in preparation). Upload site photos → AI segmentation + depth → environmental indicators → zone diagnostics → LLM-generated design strategies.

## Quickstart

```bash
git clone https://github.com/ZhenGtai123/scenerx.git
cd scenerx
cp .env.example .env
docker compose up
```

Then open → **http://localhost:3000**

That's it. LLM key / Vision API URL / model — all configured in the in-app **Settings** page after first launch. `.env` is not meant to be hand-edited.

<details>
<summary>Alternative startup commands</summary>

```bash
./start.sh        # macOS / Linux wrapper — also echoes URLs
.\start.ps1       # Windows PowerShell wrapper
docker compose up -d                    # detached (no live logs)
docker compose --profile gpu up -d      # also run vision-api locally (NVIDIA GPU required)
```
</details>

<details>
<summary>Where does the Vision API run? (read if vision step fails)</summary>

SceneRx itself does no GPU work — it calls out to an external Vision API for segmentation + depth. The default `VISION_API_URL=http://host.docker.internal:8000` points at **the host machine's port 8000**, which works as-is for all three setups — no edit needed:

- **`docker compose --profile gpu up -d`** (single-stack) — the bundled `vision-api` container publishes `8000:8000` to the host, so the default reaches it. **No Settings change required.**
- **AI_City_View running as a separate stack on the same host** — `cd ../AI_City_View && docker compose up`.
- **Vision-api running natively (python) on the same host.**

> Optional (single-stack gpu only): you may set `VISION_API_URL=http://vision-api:8000` in the Settings page — the in-network service name gives a direct container-to-container hop instead of bouncing through the host gateway. Minor optimisation, not required; the name only resolves inside this compose project, which is why it can't be the default.
</details>

This repository offers **three reproducibility paths**, in increasing order of effort:

| Path | Audience | Hardware | Setup time |
|---|---|---|---|
| **A. Live demo** | reviewers, curious readers | none (browser) | 0 min |
| **B. Reproduce paper figures** | researchers verifying claims | NVIDIA GPU 8 GB+ *or* remote vision-api | ~20 min |
| **C. Use with your own data** | extending the work | same as B | same |

---

## A. Live demo (no install)

→ **[scenerx on Hugging Face Spaces](https://huggingface.co/spaces/ZhenGtai123/scenerx)** — upload an image, see segmentation + depth + FMB layers in ~30 s.

This demo runs the **vision pipeline only** (Stage 2). For zone analysis, indicator computation, and design strategies, use Path B or C below.

---

## B. Reproduce paper figures

### Prerequisites

| Required | Why |
|---|---|
| Docker Engine 24+ with `docker compose` | runs all services |
| One LLM API key — Gemini / OpenAI / Anthropic / DeepSeek | drives recommendation + design stages |
| (Optional) NVIDIA GPU ≥ 8 GB VRAM + [Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) | run vision-api locally; otherwise point at a remote endpoint |

> **Windows:** Docker Desktop must use the WSL2 backend, and the NVIDIA Container Toolkit must be installed *inside* WSL2. Verify with `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`.

### Steps

Same as the Quickstart above. For paper figure reproduction, use the GPU profile so vision-api runs locally:

```bash
docker compose --profile gpu up -d
```

First run takes ~15–25 min for the GPU profile (model weights download into a cached volume). Subsequent runs are under 30 s. Linux/macOS shortcut: `make reproduce`.

Then open **http://localhost:3000** and:

1. Create a project from `samples/inputs/` (drag-and-drop)
2. Run the pipeline (Vision → Indicators → Analysis → Report)
3. Compare outputs to `samples/expected_outputs/` — see [`samples/expected_outputs/README.md`](./samples/expected_outputs/README.md) for the diff procedure and per-stage tolerances.

### Without a local GPU

You can run *every other stage* locally and offload only the vision pass:

```bash
# Option 1 — point at the public Hugging Face Space:
echo 'VISION_API_URL=https://zhengtai123-scenerx.hf.space/api' >> .env
make up                    # starts everything except vision-api

# Option 2 — Colab tunnel (free T4 GPU):
# See AI_City_View/vision_api_colab.ipynb for the ngrok-based recipe.
```

### Verifying the deployment

```bash
make health                # hits each /health endpoint
make logs                  # tail all services
make ps                    # list running containers
```

---

## C. Use with your own data

Same setup as Path B, but skip the bundled samples and create a project from your own imagery. Workflow:

1. **Create project** — name, location, climate zone, performance dimensions, spatial zones
2. **Upload photos** — drag-and-drop, assign to spatial zones
3. **Vision analysis** — semantic segmentation + depth (saved as masks)
4. **Indicator recommendation** — LLM picks indicators relevant to your dimensions
5. **Pipeline run** — metrics → multi-layer aggregation → z-score diagnostics → design strategies
6. **Export** — Markdown / PDF / JSON reports, with embedded charts

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React + Chakra UI)                       │
│    Docker: :3000   |   Dev (npm run dev): :5173     │
└────────────────────┬────────────────────────────────┘
                     │ HTTP (Axios)
┌────────────────────▼────────────────────────────────┐
│  Backend (FastAPI)  :8080                           │
│  /api/projects  /api/vision  /api/metrics           │
│  /api/indicators  /api/analysis  /api/config        │
└──────┬──────────────┬───────────────────────────────┘
       │              │ HTTP
       │   ┌──────────▼────────────────┐
       │   │ Vision API  :8000         │
       │   │ (GHCR image OR remote)    │
       │   │ semantic + depth          │
       │   └───────────────────────────┘
       │
  ┌────▼──────┐  ┌────────────────┐
  │ LLM API   │  │ Postgres + Redis│
  │ Gemini /  │  │ (+ Celery)      │
  │ OpenAI /… │  └────────────────┘
  └───────────┘
```

### Pipeline stages

| Stage | Description | Component |
|---|---|---|
| 1 | **Indicator Recommendation** — LLM selects relevant indicators from knowledge base | `RecommendationService` |
| 2 | **Vision Analysis** — Semantic segmentation + FMB layer masks | Vision API → `VisionModelClient` |
| 2.5 | **Metrics Calculation** — Per-image indicator values, aggregated by zone × layer | `MetricsCalculator` → `MetricsAggregator` |
| 3 | **Zone Analysis** — Descriptive z-score diagnostics across zones | `ZoneAnalyzer` (v6.0) |
| 4 | **Design Strategies** — LLM-generated intervention strategies grounded in evidence | `DesignEngine` (v6.0) |

### Paper alignment

The manuscript and architecture figure should align to the current code facts
recorded in [`docs/paper_repo_mapping.md`](./docs/paper_repo_mapping.md) and
[`docs/reproducibility_manifest.json`](./docs/reproducibility_manifest.json).
Those files are the repo-side checklist for matching the paper, SceneRX-AI
figure, this app, and the sibling `AI_City_View` vision service.

### Tech stack

**Backend** FastAPI · Pydantic v2 · SQLAlchemy · Celery · multi-LLM (Gemini / OpenAI / Anthropic / DeepSeek)
**Frontend** React 19 · TypeScript · Vite 7 · Chakra UI v2 · TanStack Query v5 · Zustand v5
**External** OneFormer (ADE20K segmentation) · Depth Anything V3 (monocular depth)

---

## Manual setup (development)

If you're editing backend or frontend code, skip Docker and run the two
services on the host. Prerequisites: Python 3.11+, Node.js 18+, an LLM
API key, and a Vision API endpoint (local or remote).

```bash
cp .env.example .env              # root-level .env — backend reads it via _find_env_file()

# Backend
cd packages/backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
python -m app.main                # http://localhost:8080

# Frontend (separate terminal)
cd packages/frontend
npm install
npm run dev                       # http://localhost:5173
```

If the backend reports `[WinError 10013]` on Windows, the port is held by Hyper-V's dynamic reservation pool. The startup script prints two fixes; the persistent one is:

```powershell
# Admin PowerShell, run once:
netsh int ipv4 add excludedportrange protocol=tcp startport=8080 numberofports=1 store=persistent
```

---

## API reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/projects` | Create project |
| `POST` | `/api/projects/{id}/images` | Upload images |
| `POST` | `/api/vision/analyze/project-image` | Run vision analysis + persist masks |
| `POST` | `/api/indicators/recommend` | LLM-recommended indicators |
| `POST` | `/api/analysis/project-pipeline` | Run end-to-end pipeline |
| `POST` | `/api/analysis/generate-report` | Generate the LLM-narrated report |
| `GET`  | `/api/config/llm-providers` | List configured LLM providers |
| `PUT`  | `/api/config/llm-provider?provider=openai` | Switch LLM at runtime |

Full interactive docs: **http://localhost:8080/docs**

---

## Project layout

```
scenerx/
├── docker-compose.yml          # default stack (vision-api opt-in via --profile gpu)
├── docker-compose.build.yml    # override to build vision-api from sibling repo
├── docker-compose.dev.yml      # hot-reload dev mode
├── Makefile                    # convenience targets — run `make help`
├── .env.example                # configuration template
├── samples/
│   ├── inputs/                 # reproduction input images
│   └── expected_outputs/       # reference outputs + tolerance spec
├── hf_space/                   # Hugging Face Space scaffold (Path A)
└── packages/
    ├── backend/                # FastAPI service (Stage 1 / 2.5 / 3 / 4)
    │   ├── app/
    │   ├── data/               # indicator library + knowledge base
    │   └── requirements.txt    # pinned for reproducibility
    └── frontend/               # React UI
```

---

## Known limitations

- **Auth disabled by default** — `AUTH_ENABLED=false`; flip in production.
- **In-memory user store** — only project data is persisted (SQLite); user accounts are not.
- **LLM outputs non-deterministic** — design strategies vary between runs even with fixed inputs; treat as informational, not as ground truth.

---

## Citation

If you use SceneRx in academic work, please cite the paper (and the underlying vision models):

```bibtex
@misc{scenerx2026,
  title  = {SceneRx: An AI-Augmented Pipeline for Urban Greenspace Performance Diagnosis},
  author = {Lan, Junkai},                          % TODO: confirm and add co-authors
  year   = {2026},
  doi    = {10.5281/zenodo.PENDING},                % TODO: replace once Zenodo DOI is minted
  url    = {https://github.com/ZhenGtai123/scenerx}
}
```

The vision module relies on:

- **OneFormer** — Jain et al., *OneFormer: One Transformer to Rule Universal Image Segmentation*, CVPR 2023.
- **Depth Anything V3** — ByteDance Seed et al., *Depth Anything 3: Recovering the Visual Space from Any Views*, 2025.

A `CITATION.cff` is provided so GitHub renders a "Cite this repository" button.

## License

Released under the **MIT License** — see [LICENSE](./LICENSE).
