PORT = 3000

.PHONY: start

# Runs in the FOREGROUND: the terminal holds the server and Ctrl-C stops it.
# `exec` replaces make's shell with serve, so Ctrl-C and the exit status reach
# the server directly instead of going through an intermediate shell.
#
# --no-port-switching makes a busy port a loud failure rather than a silent
# move to 3001, which is worth keeping — a server quietly on the wrong port is
# how you end up testing a stale tab.
start:
	@echo "Serving http://localhost:$(PORT)  ·  Ctrl-C to stop"
	@exec npx serve -l $(PORT) --no-port-switching .
