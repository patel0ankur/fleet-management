.PHONY: help tools-check install synth diff deploy destroy lint test clean cli-build

CONFIG ?= config/platform.yaml

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

tools-check: ## Verify required CLI tools are installed
	@./hack/check-tools.sh

install: ## Install Node deps for the CDK app
	npm ci

synth: ## cdk synth (uses $CONFIG)
	npx cdk synth --context configFile=$(CONFIG)

diff: ## cdk diff against deployed stacks
	npx cdk diff --context configFile=$(CONFIG)

deploy: ## Deploy all stacks
	npx cdk deploy --all --require-approval never --context configFile=$(CONFIG)

destroy: ## Destroy all stacks (DANGEROUS)
	npx cdk destroy --all --force --context configFile=$(CONFIG)

lint: ## Lint TS + Go
	npx tsc --noEmit
	cd cli/fleetctl && go vet ./...

test: ## Run unit tests
	npx jest --passWithNoTests
	cd cli/fleetctl && go test ./...

cli-build: ## Build fleetctl binary
	cd cli/fleetctl && go build -o fleetctl .

clean:
	rm -rf cdk.out node_modules cli/fleetctl/fleetctl
