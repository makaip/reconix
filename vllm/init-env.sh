# Creates reconix.env
# Then, isource opencode/reconix.env
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[[ -f reconix.env ]] && { echo "reconix.env already exists; leaving it alone"; exit 0; }

SHARED_VLLM_KEY="$(openssl rand -hex 24)"

cat > reconix.env <<EOF
export OPENCODE_SERVER_PASSWORD=$(openssl rand -hex 24)
export OPENCODE_PORT=4096

# orchestrator (Qwen2.5-14B-Instruct-AWQ, profiles/orchestrator.env) 
export ORCHESTRATOR_PORT=8001
export ORCHESTRATOR_API_KEY=$SHARED_VLLM_KEY

# evaluator (Qwen2.5-7B-Instruct-AWQ, profiles/evaluator.env)
export EVALUATOR_PORT=8002
export EVALUATOR_API_KEY=$SHARED_VLLM_KEY

# dom-analyzer (Qwen2.5-3B-Instruct, profiles/dom-analyzer.env)
export DOM_PORT=8003
export DOM_API_KEY=$SHARED_VLLM_KEY

# export CUDA_HOME=/usr/local/cuda-13.0
# export PATH=\$CUDA_HOME/bin:\$PATH
EOF
chmod 600 reconix.env