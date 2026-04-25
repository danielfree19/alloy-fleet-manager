# Conveniences for working on the provider. None of these are required — you
# can always run `go build .` and `terraform plan` by hand.

BINARY := terraform-provider-fleet
VERSION ?= dev

.PHONY: build fmt vet tidy clean

build:
	go build -ldflags="-X main.version=$(VERSION)" -o $(BINARY) .

fmt:
	go fmt ./...

vet:
	go vet ./...

tidy:
	go mod tidy

clean:
	rm -f $(BINARY)
