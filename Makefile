.DEFAULT_GOAL := help

UV := uv
CARGO := cargo
NATIVE := native
NATIVE_MANIFEST := $(NATIVE)/Cargo.toml
WORKER := .venv/bin/machinewright-worker
REFERENCE_PROJECT := examples/reference_project.py

.PHONY: help
help: ## Show this help
	@echo "Machinewright — common tasks"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

## --- Python (Core / CLI / worker) -----------------------------------------

.PHONY: sync
sync: ## Install/sync the Python environment (uv, all dev tools included)
	$(UV) sync --all-groups --frozen

.PHONY: generate
generate: ## Regenerate the worker protocol and JSON schemas from source
	$(UV) run python scripts/generate_protocol.py
	$(UV) run python scripts/generate_schemas.py

.PHONY: test-py
test-py: ## Run the Python test suite
	$(UV) run pytest -q

.PHONY: lint-py
lint-py: ## Lint Python with ruff
	$(UV) run ruff check .

.PHONY: fmt-py
fmt-py: ## Auto-format Python with ruff
	$(UV) run ruff format .

.PHONY: typecheck-py
typecheck-py: ## Type-check Python with mypy
	$(UV) run mypy -p machinewright

.PHONY: check-py
check-py: lint-py typecheck-py test-py ## Run all Python checks (lint, typecheck, test)

## --- Rust (native application) ---------------------------------------------

.PHONY: build
build: ## Build the whole native Rust workspace (debug)
	$(CARGO) build --manifest-path $(NATIVE_MANIFEST) --workspace

.PHONY: build-release
build-release: ## Build the native application in release mode
	$(CARGO) build --manifest-path $(NATIVE_MANIFEST) --workspace --release

.PHONY: test
test: ## Run native Rust tests (same scope as CI's native-core job)
	$(CARGO) test --manifest-path $(NATIVE_MANIFEST) --workspace --exclude machinewright-floem

.PHONY: test-all
test-all: ## Run native Rust tests, including the Floem adapter
	$(CARGO) test --manifest-path $(NATIVE_MANIFEST) --workspace

.PHONY: clippy
clippy: ## Lint native Rust with clippy (same scope as CI's native-core job)
	$(CARGO) clippy --manifest-path $(NATIVE_MANIFEST) --workspace --exclude machinewright-floem --all-targets -- -D warnings

.PHONY: clippy-floem
clippy-floem: ## Lint the Floem adapter with clippy (not run in CI, but kept clean)
	$(CARGO) clippy --manifest-path $(NATIVE_MANIFEST) -p machinewright-floem --all-targets -- -D warnings

.PHONY: clippy-all
clippy-all: clippy clippy-floem ## Lint the entire native workspace, including Floem

.PHONY: fmt
fmt: ## Auto-format the native Rust workspace
	$(CARGO) fmt --manifest-path $(NATIVE_MANIFEST) --all

.PHONY: fmt-check
fmt-check: ## Check native Rust formatting without changing files
	$(CARGO) fmt --manifest-path $(NATIVE_MANIFEST) --all -- --check

.PHONY: check
check: fmt-check clippy-all test-all ## Run all native Rust checks (fmt, clippy, tests)

## --- Running / seeing progress ----------------------------------------------

.PHONY: run
run: ## Launch the native app on the reference project (see it running)
	MACHINEWRIGHT_WORKER=$(WORKER) $(CARGO) run --manifest-path $(NATIVE_MANIFEST) \
		-p machinewright-floem --bin machinewright-floem -- $(REFERENCE_PROJECT)

.PHONY: smoke
smoke: ## Headless end-to-end sanity check: evaluate the reference project once
	$(CARGO) run --manifest-path $(NATIVE_MANIFEST) -p machinewright-floem --bin authoring_smoke -- \
		$(REFERENCE_PROJECT) $(WORKER)

## --- Everything ---------------------------------------------------------

.PHONY: ci
ci: generate check-py fmt-check clippy build test build-release ## Mirror .github/workflows/native.yml locally
	@git diff --exit-code -- src/machinewright/protocol src/machinewright/schemas
	@echo "All CI-equivalent checks passed."

.PHONY: clean
clean: ## Remove build artifacts and caches
	$(CARGO) clean --manifest-path $(NATIVE_MANIFEST)
	rm -rf .pytest_cache .mypy_cache .ruff_cache
	find . -type d -name __pycache__ -not -path "./.venv/*" -prune -exec rm -rf {} +
