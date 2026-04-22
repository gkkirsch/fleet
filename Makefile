.PHONY: build backend ui clean install

build: backend ui

backend:
	go build -o fleetview .

ui:
	cd web && npm install --silent --no-audit --no-fund && npm run build

install: build
	install -m 0755 fleetview $(HOME)/.local/bin/fleetview

clean:
	rm -f fleetview
	rm -rf web/dist web/node_modules
