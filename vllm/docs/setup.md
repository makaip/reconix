cd ~/reconix

# creates vllm/reconix.env with fresh random secrets
./vllm/init-env.sh
source reconix.env

# model servers (start one at a time first time to catch sizing issues)
./vllm/serve.sh serve orchestrator
./vllm/serve.sh serve evaluator
./vllm/serve.sh serve dom-analyzer
./vllm/serve.sh status           

# quick API-level check per model (optional)
./vllm/serve.sh test orchestrator

# OpenCode
export ORCHESTRATOR_BASE_URL=http://127.0.0.1:8001/v1
export EVALUATOR_BASE_URL=http://127.0.0.1:8002/v1
export DOM_BASE_URL=http://127.0.0.1:8003/v1
opencode

# for other machines to access
For WSL laptops
notepad $env:USERPROFILE\.wslconfig
write:
[wsl2]
networkingMode=mirrored

wsl --shutdown

Log into tailscale from other device. Device should see laptop with ip 100.88.117.77 if shared in to the tailnet

tailscale status              # host should be listed
ping 100.88.117.77             # should get replies
curl -v http://100.88.117.77:8001/v1/models -H "Authorization: Bearer <key>"

key is VLLM_API_KEY or any of the individual model keys

Point opencode at the terminal
export ORCHESTRATOR_BASE_URL=http://100.88.117.77:8001/v1
export ORCHESTRATOR_API_KEY=<the shared VLLM_API_KEY from the host>
export EVALUATOR_BASE_URL=http://100.88.117.77:8002/v1
export EVALUATOR_API_KEY=<same key>
export DOM_BASE_URL=http://100.88.117.77:8003/v1
export DOM_API_KEY=<same key>
opencode