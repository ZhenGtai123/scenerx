# =============================================================================
# SceneRx — convenience entry points
# Run `make help` to see all targets. All targets are thin wrappers around
# docker compose so you can also run the underlying commands by hand.
# =============================================================================

SHELL          := /bin/bash
COMPOSE        := docker compose
COMPOSE_GPU    := docker compose --profile gpu
COMPOSE_BUILD  := docker compose -f docker-compose.yml -f docker-compose.build.yml --profile gpu
COMPOSE_DEV    := docker compose -f docker-compose.yml -f docker-compose.dev.yml

.DEFAULT_GOAL := help

# -----------------------------------------------------------------------------
help: ## Show this help.
	@awk 'BEGIN{FS=":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n\nTargets:\n"} \
	     /^[a-zA-Z_-]+:.*?##/{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""

# -----------------------------------------------------------------------------
# Setup
# -----------------------------------------------------------------------------
.env: ## Bootstrap .env from .env.example if missing.
	@test -f .env || (cp .env.example .env && echo "Created .env — open it and fill in your LLM API key.")

# -----------------------------------------------------------------------------
# Run
# -----------------------------------------------------------------------------
up: .env ## Start everything except vision-api (use a remote VISION_API_URL).
	$(COMPOSE) up -d
	@echo ""
	@echo "  Frontend:  http://localhost:3000"
	@echo "  Backend:   http://localhost:8080"
	@echo ""
	@echo "  Settings UI: http://localhost:3000/settings  (set VISION_API_URL here)"

up-gpu: .env ## Start everything including local vision-api (requires NVIDIA GPU).
	$(COMPOSE_GPU) up -d
	@echo ""
	@echo "  Frontend:    http://localhost:3000"
	@echo "  Backend:     http://localhost:8080"
	@echo "  Vision API:  http://localhost:8000  (also reachable in-network as http://vision-api:8000)"

reproduce: .env ## Pull pinned images and bring up the full stack for paper reproduction.
	$(COMPOSE_GPU) pull
	$(COMPOSE_GPU) up -d
	@echo ""
	@echo "Waiting for services to become healthy (up to 3 min)..."
	@for i in $$(seq 1 36); do \
	  if curl -fs http://localhost:8080/health > /dev/null 2>&1; then \
	    echo "✓ backend healthy"; break; \
	  fi; sleep 5; \
	done
	@echo ""
	@echo "Open http://localhost:3000 — see README §B for the reproduction walkthrough."

build-vision: .env ## Build vision-api from a sibling AI_City_View checkout (advanced).
	$(COMPOSE_BUILD) up -d --build

dev: .env ## Hot-reload dev mode (uses docker-compose.dev.yml).
	$(COMPOSE_DEV) up

# -----------------------------------------------------------------------------
# Lifecycle
# -----------------------------------------------------------------------------
down: ## Stop and remove containers (volumes preserved).
	$(COMPOSE_GPU) down

down-clean: ## Stop and remove containers AND volumes (destroys data).
	$(COMPOSE_GPU) down -v

restart: ## Restart all running services.
	$(COMPOSE_GPU) restart

logs: ## Tail logs for all services.
	$(COMPOSE_GPU) logs -f

logs-vision: ## Tail logs for vision-api only.
	$(COMPOSE_GPU) logs -f vision-api

ps: ## List running services.
	$(COMPOSE_GPU) ps

# -----------------------------------------------------------------------------
# Verification
# -----------------------------------------------------------------------------
health: ## Hit each service's /health endpoint.
	@echo "backend:    " && curl -fs http://localhost:8080/health || echo "  (unreachable)"
	@echo "vision-api: " && curl -fs http://localhost:8000/health || echo "  (unreachable — start with 'make up-gpu' or set VISION_API_URL)"
	@echo "frontend:   " && curl -fs -o /dev/null -w '  HTTP %{http_code}\n' http://localhost:3000 || echo "  (unreachable)"

test: ## Run backend pytest suite inside the container.
	$(COMPOSE) exec backend pytest -q

# -----------------------------------------------------------------------------
.PHONY: help up up-gpu reproduce build-vision dev down down-clean restart logs logs-vision ps health test
