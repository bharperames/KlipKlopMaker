PID_FILE = .server.pid
PORT = 3000

.PHONY: start stop restart status

start:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Server is already running on port $(PORT) (PID $$(cat $(PID_FILE)))"; \
	else \
		echo "Starting serve on port $(PORT)..."; \
		npx serve -l $(PORT) --no-port-switching . > server.log 2>&1 & echo $$! > $(PID_FILE); \
		sleep 1; \
		if kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
			echo "Server started successfully on http://localhost:$(PORT)"; \
		else \
			echo "Failed to start server. Check server.log for details."; \
			rm -f $(PID_FILE); \
		fi; \
	fi

stop:
	@if [ -f $(PID_FILE) ]; then \
		PID=$$(cat $(PID_FILE)); \
		if kill -0 $$PID 2>/dev/null; then \
			echo "Stopping server (PID $$PID)..."; \
			kill $$PID; \
			rm -f $(PID_FILE); \
			echo "Server stopped."; \
		else \
			echo "Server process $$PID not running."; \
			rm -f $(PID_FILE); \
		fi; \
	else \
		echo "No server running (no $(PID_FILE) found)."; \
	fi

restart: stop start

status:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Server is running (PID $$(cat $(PID_FILE))) on http://localhost:$(PORT)"; \
	else \
		echo "Server is stopped."; \
	fi
