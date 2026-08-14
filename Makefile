all: dev

# FFmpeg version per threading model. fftools requires threads from 6.0 onward
# (ffmpeg_deps gains `threads`; pthread_create is unconditional in demux/mux),
# so the ST core pins the last single-thread-capable LTS branch, 5.1.
FFMPEG_VERSION ?= n8.1.2
ST_FFMPEG_VERSION := n5.1.10

MT_FLAGS := -sUSE_PTHREADS -pthread

DEV_ARGS := --progress=plain

DEV_CFLAGS := --profiling
DEV_MT_CFLAGS := $(DEV_CFLAGS) $(MT_FLAGS)
PROD_CFLAGS := -O3 -msimd128
PROD_MT_CFLAGS := $(PROD_CFLAGS) $(MT_FLAGS)

clean:
	rm -rf ./packages/core$(PKG_SUFFIX)/dist

.PHONY: build
build:
# An empty FFMPEG_VERSION would override the Dockerfile ARG default and turn
# the FFmpeg ADD ref into a bare `#`, silently fetching the default branch.
ifeq ($(strip $(FFMPEG_VERSION)),)
	$(error FFMPEG_VERSION is empty; expected an FFmpeg tag such as n8.1.2)
endif
	make clean PKG_SUFFIX="$(PKG_SUFFIX)"
	EXTRA_CFLAGS="$(EXTRA_CFLAGS)" \
	EXTRA_LDFLAGS="$(EXTRA_LDFLAGS)" \
	FFMPEG_ST="$(FFMPEG_ST)" \
	FFMPEG_MT="$(FFMPEG_MT)" \
	FFMPEG_VARIANT="$(FFMPEG_VARIANT)" \
	FFMPEG_VERSION="$(FFMPEG_VERSION)" \
		docker buildx build \
			--build-arg EXTRA_CFLAGS \
			--build-arg EXTRA_LDFLAGS \
			--build-arg FFMPEG_MT \
			--build-arg FFMPEG_ST \
			--build-arg FFMPEG_VARIANT \
			--build-arg FFMPEG_VERSION \
			-o ./packages/core$(PKG_SUFFIX) \
			$(EXTRA_ARGS) \
			.

build-st:
	make build \
		FFMPEG_ST=yes \
		FFMPEG_VERSION=$(ST_FFMPEG_VERSION)

build-st-copy:
	make build \
		PKG_SUFFIX=-copy \
		FFMPEG_ST=yes \
		FFMPEG_VERSION=$(ST_FFMPEG_VERSION) \
		FFMPEG_VARIANT=copy

build-mt:
	make build \
		PKG_SUFFIX=-mt \
		FFMPEG_MT=yes \
		FFMPEG_VARIANT=full

build-mt-slim:
	make build \
		PKG_SUFFIX=-mt-slim \
		FFMPEG_MT=yes \
		FFMPEG_VARIANT=slim

dev:
	make build-st EXTRA_CFLAGS="$(DEV_CFLAGS)" EXTRA_ARGS="$(DEV_ARGS)"

dev-mt:
	make build-mt EXTRA_CFLAGS="$(DEV_MT_CFLAGS)" EXTRA_ARGS="$(DEV_ARGS)"

prd:
	make build-st EXTRA_CFLAGS="$(PROD_CFLAGS)"

prd-st-copy:
	make build-st-copy EXTRA_CFLAGS="$(PROD_CFLAGS)"

prd-mt:
	make build-mt EXTRA_CFLAGS="$(PROD_MT_CFLAGS)"

prd-mt-slim:
	make build-mt-slim EXTRA_CFLAGS="$(PROD_MT_CFLAGS)"
