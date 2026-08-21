# Managed Hermes worker image: the official Hermes Agent image plus what a
# managed tenant needs to browse like a person and phone home.
#
#   * a full (headful) Chromium next to the headless shell the upstream image
#     ships, so the agent's browser tools render real pages on a virtual
#     display instead of a headless shell;
#   * Xvfb as an s6-supervised service (DISPLAY=:99), same as the OpenClaw
#     fleet's per-container virtual display;
#   * agent-browser preinstalled globally, so the first browser tool call
#     does not shell out to the npm registry from inside a locked-down
#     container;
#   * the hermes-telemetry reporter as an s6-supervised service that
#     self-updates every 24h (npx @latest), gated on HERMES_TELEMETRY_TOKEN.
#
# Everything else (/opt/data layout, s6 PID 1, privilege drop to the hermes
# user, stage2 bootstrap) is inherited unchanged from upstream.
ARG HERMES_BASE=nousresearch/hermes-agent:latest
FROM ${HERMES_BASE}

USER root

# Headful Chromium needs X11 client libs + fonts; Playwright's --with-deps
# installs the former, we add the latter (upstream only ships the headless
# shell, which never draws glyphs). xdg-utils silences "xdg-open not found"
# warnings from pages that try to hand off to a native handler.
RUN apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
        fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core \
        xauth x11-utils xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# The same Playwright build the upstream image pinned (its headless shell is
# chromium_headless_shell-<build>); installing "chromium" from the image's own
# node_modules resolves to the matching full-browser build, into the same
# PLAYWRIGHT_BROWSERS_PATH (/opt/hermes/.playwright) that survives the
# /opt/data volume overlay.
RUN cd /opt/hermes \
    && export PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=180000 \
    && for i in 1 2 3 4 5; do \
        npx playwright install --with-deps chromium && break || \
        { [ "$i" = 5 ] && exit 1; echo "playwright install failed (attempt $i); retrying in 15s"; sleep 15; }; \
       done \
    && rm -rf /var/lib/apt/lists/* \
    && CHROME="$(find /opt/hermes/.playwright -type f -name chrome -path '*chromium-*/chrome-linux*' | head -n 1)" \
    && test -x "$CHROME" \
    && ln -sfn "$CHROME" /opt/hermes/.playwright/chrome \
    && chmod -R a+rX /opt/hermes/.playwright \
    && "$CHROME" --version

# agent-browser is what Hermes spawns for its built-in browser tools; upstream
# resolves it via `npx agent-browser@^0.26.0` on first use. Bake the same
# range so nothing is fetched at runtime.
RUN npm install -g "agent-browser@^0.26.0" && npm cache clean --force \
    && agent-browser --version

# X11 socket dir must exist with the sticky bit before Xvfb starts as the
# unprivileged hermes user.
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Headful browser on the virtual display by default. AGENT_BROWSER_EXECUTABLE_PATH
# being preset makes upstream's stage2 discovery (which would happily pick the
# headless shell) skip itself. The --no-sandbox flags match the OpenClaw fleet:
# cap_drop ALL + no-new-privileges leave Chromium's own sandbox nothing to stand
# on, so the container is the isolation boundary.
ENV DISPLAY=:99 \
    AGENT_BROWSER_HEADED=1 \
    AGENT_BROWSER_EXECUTABLE_PATH=/opt/hermes/.playwright/chrome \
    AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage"

COPY --chmod=0755 s6-rc.d/xvfb/run /etc/s6-overlay/s6-rc.d/xvfb/run
COPY s6-rc.d/xvfb/type /etc/s6-overlay/s6-rc.d/xvfb/type
COPY --chmod=0755 s6-rc.d/hermes-telemetry/run /etc/s6-overlay/s6-rc.d/hermes-telemetry/run
COPY s6-rc.d/hermes-telemetry/type /etc/s6-overlay/s6-rc.d/hermes-telemetry/type
RUN mkdir -p /etc/s6-overlay/s6-rc.d/xvfb/dependencies.d /etc/s6-overlay/s6-rc.d/hermes-telemetry/dependencies.d \
    && touch /etc/s6-overlay/s6-rc.d/xvfb/dependencies.d/base \
             /etc/s6-overlay/s6-rc.d/hermes-telemetry/dependencies.d/base \
             /etc/s6-overlay/s6-rc.d/user/contents.d/xvfb \
             /etc/s6-overlay/s6-rc.d/user/contents.d/hermes-telemetry

# Same ENTRYPOINT/CMD contract as upstream: `gateway run` starts the supervised gateway.
