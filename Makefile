# Local character-chat development.
.PHONY: help dev stop infra infra-down e2e

help:
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-14s %s\n", $$1, $$2}'

dev: ## character chat — open http://localhost:13000
	./scripts/dev.sh

stop: ## stop app processes started by this checkout
	./scripts/dev-stop.sh

e2e: infra ## character-chat browser suite
	pnpm --filter @shizue/contracts --filter './apps/plot/packages/*' build
	pnpm db:migrate
	pnpm test:e2e

infra: ## postgres + s3 (RustFS) containers
	docker compose up -d

infra-down: ## stop the containers
	docker compose down
