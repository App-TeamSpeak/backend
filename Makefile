API_IMAGE ?= teamspeak-backend-api:local
REALTIME_IMAGE ?= teamspeak-backend-realtime:local

.PHONY: install validate validate-api validate-realtime test firestore-smoke docker-build docker-build-api docker-build-realtime up down restart logs ps clean

install:
	npm --prefix backend-api ci
	npm --prefix backend-realtime ci

validate: validate-api validate-realtime

validate-api:
	npm --prefix backend-api run validate

validate-realtime:
	npm --prefix backend-realtime run validate

test:
	npm --prefix backend-api run test:coverage
	npm --prefix backend-realtime run test:coverage

firestore-smoke:
	npm --prefix backend-api run test:firestore

docker-build: docker-build-api docker-build-realtime

docker-build-api:
	docker build --tag $(API_IMAGE) ./backend-api

docker-build-realtime:
	docker build --tag $(REALTIME_IMAGE) ./backend-realtime

up:
	docker compose up --detach --build

down:
	docker compose down

restart: down up

logs:
	docker compose logs --follow

ps:
	docker compose ps

clean:
	rm -rf backend-api/dist backend-api/coverage backend-realtime/dist backend-realtime/coverage
