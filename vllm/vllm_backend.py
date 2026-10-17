"""vLLM backend for Reconix.

Two entry points:

* ``VLLMBackend`` -- in-process (offline) inference over explicitly loaded model
  weights. Use it for batch generation inside the harness.
* ``python -m vllm.vllm_backend serve`` -- vLLM's OpenAI-compatible HTTP server,
  which is what OpenCode talks to. ``opencode.json`` declares the provider
  ``vllm-orchestrator`` (``@ai-sdk/openai-compatible``) pointing at
  ``{env:ORCHESTRATOR_BASE_URL}`` (``http://<host>:<port>/v1``) with
  ``apiKey: {env:ORCHESTRATOR_API_KEY}`` and a model named ``orchestrator-model``;
  the defaults below line up with exactly that, so a profile can drive this
  module the same way it drives ``serve.sh``:

      set -a; source vllm/reconix.env; set +a
      set -a; source vllm/profiles/orchestrator.env; set +a
      python -m vllm.vllm_backend serve

  Every flag this module does not consume is forwarded verbatim to vLLM's serve
  parser, e.g. ``... serve --port 8002 --tool-call-parser qwen3``, and a profile's
  ``EXTRA_ARGS`` string is appended the same way, so ``--quantization awq``,
  ``--kv-cache-dtype fp8``, ``--enforce-eager`` ... are honoured without this
  module knowing about them (full parity with ``serve.sh``).

Recognised environment (all optional): MODEL (or VLLM_MODEL), SERVED_NAME,
VLLM_PORT (or PORT), BIND_HOST, GPU_FRACTION, MAX_LEN, TOOL_PARSER, VLLM_API_KEY.
``EXTRA_ARGS`` is parsed as extra serve flags; the engine-relevant subset of it
(``--quantization``, ``--max-num-seqs``, ``--kv-cache-dtype``, ...) also drives
``VLLMBackend.from_environment``, which ignores server-only flags.
"""

from __future__ import annotations

import argparse
import asyncio
import gc
import json
import os
import shlex
import sys
from typing import Any

from vllm import LLM, SamplingParams

def _env(*names: str, default: str = "") -> str:
    """First non-empty environment variable among ``names``."""
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return default

# Engine flags that may appear in EXTRA_ARGS and are legal ``vllm.LLM`` kwargs.
# Server-only flags (``--tool-call-parser``, ``--port``, ...) are deliberately
# absent: forwarding them to ``LLM()`` would raise TypeError.
# name -> (kwarg, coercion); coercion ``None`` means a boolean store_true flag.
_ENGINE_FLAG_KWARGS: dict[str, tuple[str, Any]] = {
    "--quantization": ("quantization", str),
    "--dtype": ("dtype", str),
    "--max-model-len": ("max_model_len", int),
    "--gpu-memory-utilization": ("gpu_memory_utilization", float),
    "--max-num-seqs": ("max_num_seqs", int),
    "--tensor-parallel-size": ("tensor_parallel_size", int),
    "--kv-cache-dtype": ("kv_cache_dtype", str),
    "--revision": ("revision", str),
    "--tokenizer": ("tokenizer", str),
    "--chat-template": ("chat_template", str),
    "--enforce-eager": ("enforce_eager", None),
    "--trust-remote-code": ("trust_remote_code", None),
    "--enable-prefix-caching": ("enable_prefix_caching", None),
}

def split_env_args(raw: str) -> list[str]:
    """Word-split an ``EXTRA_ARGS`` string into argv tokens.

    Non-POSIX ``shlex`` on purpose: it preserves the quotes inside embedded JSON
    values (``--default-chat-template-kwargs {"enable_thinking":false}``) that
    vLLM's parser ``json.loads``es, matching how ``serve.sh`` word-splits an
    unquoted ``$EXTRA_ARGS``. POSIX mode would hand vLLM
    ``{enable_thinking:false}``, which is not valid JSON.
    """
    # Tolerate text read straight out of a profile file (still backslash-escaped).
    raw = raw.replace('\\"', '"')
    if not raw.strip():
        return []
    try:
        return shlex.split(raw, posix=False)
    except ValueError:  # unbalanced quotes: degrade to a plain whitespace split
        return raw.split()

def _flag_present(tokens: list[str], flag: str) -> bool:
    """True if ``flag`` appears, in ``--flag value`` or ``--flag=value`` form."""
    return any(token.partition("=")[0] == flag for token in tokens)

def engine_kwargs_from_env_args(raw: str | None = None) -> dict[str, Any]:
    """Map the engine-relevant flags in ``EXTRA_ARGS`` onto ``vllm.LLM`` kwargs."""
    tokens = split_env_args(_env("EXTRA_ARGS") if raw is None else raw)
    kwargs: dict[str, Any] = {}
    index = 0
    while index < len(tokens):
        flag, _, inline_value = tokens[index].partition("=")
        index += 1
        mapping = _ENGINE_FLAG_KWARGS.get(flag)
        if mapping is None:
            continue  # unknown or server-only flag: the serve path owns it
        name, coercion = mapping

        if coercion is None:
            # store_true flag; honour an explicit ``--flag=false`` too.
            kwargs[name] = (inline_value.lower() not in {"0", "false", "no"}) if inline_value else True
            continue

        if inline_value:
            value = inline_value
        elif index < len(tokens):
            value = tokens[index]
            index += 1
        else:
            raise ValueError(f"{flag} in EXTRA_ARGS expects a value")
        try:
            kwargs[name] = coercion(value)
        except ValueError as exc:
            raise ValueError(f"{flag} in EXTRA_ARGS has invalid value {value!r}") from exc
    return kwargs

# ``Qwen/Qwen3-32B-AWQ`` is what profiles/orchestrator.env serves; a local
# directory of weights works just as well (vLLM accepts either).
DEFAULT_MODEL = "Qwen/Qwen3-32B-AWQ"
# Must match the model key OpenCode resolves (opencode.json -> agents.pentest-orchestrator.model).
DEFAULT_SERVED_NAME = "orchestrator-model"

def default_model() -> str:
    return _env("MODEL", "VLLM_MODEL", default=DEFAULT_MODEL)

def default_served_name() -> str:
    return _env("SERVED_NAME", default=DEFAULT_SERVED_NAME)

class VLLMBackend:
    """Offline vLLM engine bound to one set of model weights."""

    def __init__(
        self,
        model_path: str,
        temperature: float = 0.2,
        seed: int = 0,
        max_tokens: int = 4096,
        logprobs: int = 5,
        **engine_kwargs: Any,
    ) -> None:
        """Load ``model_path`` into a vLLM engine.

        Args:
            model_path: Local weights directory or Hugging Face repo id, e.g.
                ``/models/Qwen3-32B-AWQ`` or ``Qwen/Qwen3-32B-AWQ``.
            temperature: Sampling temperature for generation.
            seed: Seed for sampling reproducibility.
            max_tokens: Maximum token limit per completion.
            logprobs: Number of top logprobs to return per generated token.
            **engine_kwargs: Forwarded to ``vllm.LLM`` / ``EngineArgs`` --
                ``quantization``, ``dtype``, ``tensor_parallel_size``,
                ``gpu_memory_utilization``, ``max_model_len``, ``max_num_seqs``,
                ``enforce_eager``, ``kv_cache_dtype``, ``revision``,
                ``tokenizer``, ``trust_remote_code``, ...
        """
        if not model_path:
            raise ValueError("model_path is required (local weights dir or HF repo id)")

        self.model_path = model_path
        self.temperature = temperature
        self.seed = seed
        self.max_tokens = max_tokens
        self.logprobs = logprobs

        # vLLM reads the weights named by ``model`` here -- no separate load step.
        self.model = LLM(model=model_path, **engine_kwargs)

    @classmethod
    def from_environment(cls, **engine_kwargs: Any) -> "VLLMBackend":
        """Build a backend for the profile/env-selected model.

        Mirror of what ``python -m vllm.vllm_backend serve`` would load, so the
        offline and served paths stay on the same weights: ``EXTRA_ARGS``
        contributes the engine flags it is allowed to (quantization, KV cache
        dtype, eager mode, ...), then the module's own variables
        (``QUANTIZATION``/``MAX_LEN``/``GPU_FRACTION``), then explicit kwargs.
        """
        settings = engine_kwargs_from_env_args()
        if quantization := _env("QUANTIZATION"):
            settings["quantization"] = quantization
        if max_len := _env("MAX_LEN"):
            settings["max_model_len"] = int(max_len)
        if fraction := _env("GPU_FRACTION"):
            settings["gpu_memory_utilization"] = float(fraction)
        settings.update(engine_kwargs)
        return cls(
            model_path=default_model(),
            temperature=float(_env("TEMPERATURE", default="0.2")),
            seed=int(_env("SEED", default="0")),
            max_tokens=int(_env("MAX_TOKENS", default="4096")),
            **settings,
        )

    def generate(self, prompt: str) -> dict:
        """Generate a completion for ``prompt``.

        Args:
            prompt (str): Input prompt string to send to the model.

        Returns:
            dict: Payload containing generated 'text' and corresponding 'logprobs'.
        """
        params = SamplingParams(
            temperature=self.temperature,
            seed=self.seed,
            max_tokens=self.max_tokens,
            logprobs=self.logprobs,
        )

        outputs = self.model.generate([prompt], params)
        if not outputs or not outputs[0].outputs:
            return {"text": "", "logprobs": None}

        return {
            "text": outputs[0].outputs[0].text,
            "logprobs": outputs[0].outputs[0].logprobs,
        }

    def close(self) -> None:
        """Frees the vLLM engine reference and returns GPU memory to the driver."""
        if getattr(self, "model", None) is not None:
            del self.model
        gc.collect()
        try:
            import torch
        except ImportError:  # CPU-only or torch absent
            return
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

# --------------------------------------------------------------------------- #
# OpenAI-compatible server (the path OpenCode uses)
# --------------------------------------------------------------------------- #

def _serve_parser_helpers():
    """``(make_arg_parser, validate_parsed_serve_args)`` across vLLM versions.

    vLLM >= 0.11 moved these to ``vllm.entrypoints.launchers.cli_args``; older
    releases keep them in ``vllm.entrypoints.openai.cli_args``.
    """
    try:
        from vllm.entrypoints.launchers.cli_args import (  # vLLM >= 0.11
            make_arg_parser,
            validate_parsed_serve_args,
        )
    except ImportError:
        from vllm.entrypoints.openai.cli_args import (  # vLLM <= 0.10
            make_arg_parser,
            validate_parsed_serve_args,
        )
    return make_arg_parser, validate_parsed_serve_args

def _flexible_arg_parser():
    """vLLM's argparse subclass (handles ``--foo.bar`` style nested flags)."""
    try:
        from vllm.utils.argparse_utils import FlexibleArgumentParser  # vLLM >= 0.11
    except ImportError:
        from vllm.utils import FlexibleArgumentParser  # vLLM <= 0.10
    return FlexibleArgumentParser

def _run_server():
    """vLLM's async OpenAI server coroutine entry point."""
    try:
        from vllm.entrypoints.openai.api_server import run_server
    except ImportError:  # new launcher layout
        from vllm.entrypoints.launchers.api_server.entry import run_server
    return run_server

def build_serve_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse vLLM serve arguments with Reconix/OpenCode defaults applied.

    Anything the caller passes in ``argv`` overrides the injected defaults, so
    arbitrary vLLM serve flags keep working.
    """
    make_arg_parser, validate_parsed_serve_args = _serve_parser_helpers()
    parser = make_arg_parser(
        _flexible_arg_parser()(
            prog="python -m vllm.vllm_backend serve",
            description=(
                "Serve the Reconix model with vLLM's OpenAI-compatible API "
                "(consumed by OpenCode via the vllm-orchestrator provider)."
            ),
        )
    )

    defaults: dict[str, Any] = {
        "model": default_model(),
        # nargs="+" upstream: pass a list, not a bare string.
        "served_model_name": [default_served_name()],
        "host": _env("BIND_HOST", default="127.0.0.1"),
        "port": int(_env("VLLM_PORT", "PORT", default="8001")),
        "gpu_memory_utilization": float(_env("GPU_FRACTION", default="0.90")),
        "max_model_len": int(_env("MAX_LEN", default="20480")),
        "enable_prefix_caching": True,
    }

    # OpenCode sends the shared bearer token as ``Authorization: Bearer ...``;
    # leave auth off entirely when no key is configured (upstream treats an empty
    # list as "no key", which is safer as an omitted default).
    if api_key := _env("VLLM_API_KEY", "ORCHESTRATOR_API_KEY"):
        defaults["api_key"] = [api_key]

    # OpenCode is a tool-calling client: without a parser the model's tool calls
    # arrive as plain text and the agent loop stalls. A profile may supply the
    # parser through EXTRA_ARGS instead of TOOL_PARSER (serve.sh does the same).
    extra_tokens = split_env_args(_env("EXTRA_ARGS"))
    tool_parser = _env("TOOL_PARSER", default="hermes")
    if tool_parser or _flag_present(extra_tokens, "--tool-call-parser"):
        defaults["enable_auto_tool_choice"] = True
        if tool_parser:
            defaults["tool_call_parser"] = tool_parser

    # Qwen3 emits thinking blocks unless told not to; OpenCode does not want them.
    if "qwen3" in default_model().lower():
        defaults["default_chat_template_kwargs"] = {"enable_thinking": False}

    parser.set_defaults(**defaults)

    # EXTRA_ARGS first: for scalar flags argparse keeps the last value, so an
    # explicit CLI flag always beats the profile.
    args = parser.parse_args([*extra_tokens, *list(argv or [])])
    _coerce_chat_template_kwargs(args)
    validate_parsed_serve_args(args)
    return args

def _coerce_chat_template_kwargs(args: argparse.Namespace) -> None:
    """Ensure ``default_chat_template_kwargs`` is a dict, not a JSON string.

    vLLM recent releases type this field as ``dict`` while older ones run the
    CLI value through ``json.loads``; a profile-supplied value arrives as a
    string either way, so normalise it before the server sees it.
    """
    value = getattr(args, "default_chat_template_kwargs", None)
    if not isinstance(value, str):
        return
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        try:  # tolerate an extra layer of shell quoting: '{"enable_thinking":false}'
            parsed = json.loads(value.strip().strip("'\""))
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid --default-chat-template-kwargs: {value!r}") from exc
    args.default_chat_template_kwargs = parsed

def serve(argv: list[str] | None = None) -> None:
    """Run the OpenAI-compatible server (blocks until shutdown)."""
    args = build_serve_args(argv)
    probe_host = "127.0.0.1" if args.host in {"0.0.0.0", ""} else args.host
    model_name = args.served_model_name[0] if args.served_model_name else args.model

    print(
        f"serving {args.model} as '{model_name}' on http://{args.host}:{args.port}\n"
        f"  OpenCode: ORCHESTRATOR_BASE_URL=http://{probe_host}:{args.port}/v1 "
        f"ORCHESTRATOR_API_KEY={'(set)' if getattr(args, 'api_key', None) else '(none)'}",
        flush=True,
    )

    asyncio.run(_run_server()(args))

USAGE = """usage: python -m vllm.vllm_backend serve [vllm serve flags...]

  serve    Start the OpenAI-compatible API server OpenCode connects to.
           Defaults come from MODEL/SERVED_NAME/VLLM_PORT/BIND_HOST/
           GPU_FRACTION/MAX_LEN/TOOL_PARSER/VLLM_API_KEY, plus any flags in
           EXTRA_ARGS (as set by vllm/profiles/*.env), unless overridden:
           explicit flags beat EXTRA_ARGS, which beats the defaults.
           e.g. ... serve --model /models/Qwen3-32B-AWQ --port 8001
"""

def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in {"-h", "--help"}:
        print(USAGE, end="")
        return 0 if argv else 2
    if argv[0] != "serve":
        print(USAGE, file=sys.stderr, end="")
        return 2

    serve(argv[1:])
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
