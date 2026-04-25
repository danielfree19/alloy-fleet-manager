# Convenience targets for fleetctl dev work.

BINARY = fleetctl
PKG    = .

.PHONY: build fmt vet tidy test clean install

build:
	go build -o $(BINARY) $(PKG)

fmt:
	go fmt ./...

vet:
	go vet ./...

tidy:
	go mod tidy

test:
	go test ./...

clean:
	rm -f $(BINARY)

install:
	go install $(PKG)
