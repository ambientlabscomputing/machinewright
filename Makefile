.DEFAULT_GOAL := help

UV := uv
NPM := npm --prefix app

.PHONY: help
help: ## Show this help
	@echo "Machinewright — common tasks"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

## --- Run ------------------------------------------------------------------

.PHONY: run
run: app-macos-build ## Build and launch the RN macOS app — the canonical way to run it locally
	@pkill -f "MachinewrightApp.app/Contents/MacOS/MachinewrightApp" 2>/dev/null; true
	@if [ "$$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8081/status 2>/dev/null)" != "200" ]; then \
		echo "Starting Metro in the background (log: /tmp/machinewright-metro.log)..."; \
		(cd app && nohup npx react-native start > /tmp/machinewright-metro.log 2>&1 &); \
		for i in $$(seq 1 30); do \
			[ "$$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8081/status 2>/dev/null)" = "200" ] && break; \
			sleep 1; \
		done; \
	else \
		echo "Metro already running on :8081"; \
	fi
	@settings=$$(cd app/macos && xcodebuild -workspace MachinewrightApp.xcworkspace \
		-scheme MachinewrightApp-macOS -configuration Debug -showBuildSettings 2>/dev/null); \
	target_dir=$$(echo "$$settings" | grep -m1 "TARGET_BUILD_DIR =" | sed 's/.*= //'); \
	product=$$(echo "$$settings" | grep -m1 "FULL_PRODUCT_NAME =" | sed 's/.*= //'); \
	echo "Launching $$target_dir/$$product"; \
	open "$$target_dir/$$product"
	@echo "Metro log: /tmp/machinewright-metro.log — stop it with: pkill -f 'react-native start'"

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

## --- Application (React Native / TypeScript, app/) --------------------------

.PHONY: app-install
app-install: ## Install the app/ package's npm dependencies
	$(NPM) install

.PHONY: app-generate
app-generate: ## Regenerate app/'s TS protocol bindings and model types
	$(NPM) run generate

.PHONY: app-build-web
app-build-web: ## Bundle the WebView surfaces (CodeMirror, three.js) for offline loading
	$(NPM) run build:web

.PHONY: app-typecheck
app-typecheck: ## Type-check the app/ package
	$(NPM) run typecheck

.PHONY: app-lint
app-lint: ## Lint the app/ package
	$(NPM) run lint

.PHONY: app-test
app-test: ## Run the app/ package's protocol/model test suite (spawns the real Python worker)
	$(NPM) test

.PHONY: app-test-rn
app-test-rn: ## Run the app/ package's RN component smoke test (jest)
	$(NPM) run test:app

.PHONY: app-pod-install
app-pod-install: ## Install app/macos's CocoaPods dependencies
	cd app && pod install --project-directory=macos

.PHONY: app-macos-build
app-macos-build: app-pod-install app-build-web ## Build the RN macOS app (debug)
	cd app/macos && xcodebuild -workspace MachinewrightApp.xcworkspace \
		-scheme MachinewrightApp-macOS -configuration Debug \
		-destination 'platform=macOS' build

.PHONY: app-macos-run
app-macos-run: app-build-web ## Launch the RN macOS app (starts Metro if not already running)
	cd app && npm run macos

.PHONY: app-check
app-check: app-generate app-typecheck app-lint app-test app-test-rn ## Run all app/ checks (excludes the Xcode build; see app-macos-build)

## --- Everything ---------------------------------------------------------

.PHONY: ci
ci: generate check-py app-check app-macos-build ## Mirror CI locally (Python + app/ + Xcode build)
	@git diff --exit-code -- src/machinewright/protocol src/machinewright/schemas
	@git diff --exit-code -- app/src/protocol/worker app/src/model/generated
	@echo "All CI-equivalent checks passed."

.PHONY: clean
clean: ## Remove build artifacts and caches
	rm -rf .pytest_cache .mypy_cache .ruff_cache
	rm -rf app/node_modules app/dist app/macos/Pods app/macos/build
	find . -type d -name __pycache__ -not -path "./.venv/*" -prune -exec rm -rf {} +
