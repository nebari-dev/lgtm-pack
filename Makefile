# Minimal Makefile for local development
# Only two commands needed - Tilt handles everything else via its UI

.PHONY: up down

# Start local development environment
# - ctlptl apply is idempotent (creates cluster only if not exists)
# - tilt up starts the dev loop with UI at http://localhost:10350
up:
	ctlptl apply -f ctlptl-config.yaml
	@pgrep -f "tilt up" >/dev/null && echo "Tilt already running at http://localhost:10350" || tilt up

# Tear down local development environment
down:
	-tilt down
	-pkill -f "tilt up" 2>/dev/null || true
	ctlptl delete -f ctlptl-config.yaml

DOCS_DIR := docs

.PHONY: docs docs-install docs-build docs-preview docs-test docs-check-links

docs: ## Run the docs site dev server with hot reload (installs deps on first run)
	cd $(DOCS_DIR) && { [ -d node_modules ] || npm install; } && npm run dev

docs-install: ## Install docs site dependencies from the lockfile (npm ci)
	cd $(DOCS_DIR) && npm ci

docs-build: ## Build the static docs site into docs/dist
	cd $(DOCS_DIR) && npm run build

docs-preview: ## Serve the built docs/dist locally to preview the production build
	cd $(DOCS_DIR) && npm run preview

docs-test: ## Run the docs unit tests (vitest)
	cd $(DOCS_DIR) && npm test

docs-check-links: ## Build the site and verify every internal link resolves
	bash scripts/check-links.sh
