"""
Abstract LLM Client + Provider Implementations

Supports Gemini, OpenAI, Anthropic, and DeepSeek (via OpenAI SDK with custom base_url).
Each provider uses lazy imports so only the active provider's SDK needs to be installed.
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Optional

logger = logging.getLogger(__name__)


# v4 / Module 13 — Output token budget for the AI Report path.
#
# Why 32000? The full Section 4 of an 8-cluster × 3-strategies report costs
# ~3600 words ≈ 5400 tokens; the rest of the report adds another ~4000 words
# ≈ 6000 tokens; total ~9500 tokens. Padding to 32K gives plenty of headroom
# for K=15+ cluster reports and longer strategy entries without forcing the
# model to truncate mid-cluster (which was the silent reason 8-cluster
# reports were only listing 4 clusters).
#
# Per-provider clamping (SDKs silently clamp to provider max when needed):
#   - Gemini 2.5 Flash       → 8192   (provider cap)
#   - Gemini 2.5 Pro         → 65536
#   - Gemini 3 Pro Preview   → 64000+ (varies by snapshot)
#   - GPT-4o                 → 16384
#   - Claude Sonnet 4        → 64000
# 32K stays under every cap above 16K but is well above what we actually
# need for typical K=4-12 reports. Bump higher (up to 64000) only if a
# specific report keeps getting truncated near the limit.
DEFAULT_MAX_OUTPUT_TOKENS = 32000


# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

LLM_PROVIDERS = {
    "gemini": {"name": "Google Gemini", "default_model": "gemini-2.5-flash"},
    "openai": {"name": "OpenAI", "default_model": "gpt-4o"},
    "anthropic": {"name": "Anthropic Claude", "default_model": "claude-sonnet-4-20250514"},
    "deepseek": {"name": "DeepSeek", "default_model": "deepseek-chat"},
}


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------

class LLMClient(ABC):
    """Abstract LLM client for text generation.

    After every ``generate()`` call, the following side-effect attributes
    are set on the client so the caller can check whether the response was
    truncated by the output-token cap:

      * ``last_finish_reason``: provider-native finish reason string
        (e.g. Gemini ``"MAX_TOKENS"``, OpenAI ``"length"``, Anthropic
        ``"max_tokens"``). ``None`` if the SDK didn't surface one.
      * ``last_truncated``: True when ``last_finish_reason`` matches one of
        the known "hit token cap" sentinels above. The caller (typically
        ReportService) reads this immediately after ``await generate()``
        and uses it to attach a warning to the response metadata.
      * ``last_output_tokens``: the actual number of output tokens the
        model emitted, when the SDK reports it. Useful for tuning
        DEFAULT_MAX_OUTPUT_TOKENS.

    These attributes are NOT thread-safe across concurrent ``generate()``
    calls on the same client instance — but our usage is sequential per
    request, so this is fine. If we ever fan out report generation, we
    should refactor ``generate()`` to return a result dataclass instead.
    """

    provider: str
    model: str
    last_finish_reason: Optional[str] = None
    last_truncated: bool = False
    last_output_tokens: Optional[int] = None

    @abstractmethod
    async def generate(self, prompt: str) -> str:
        """Send prompt, return text response."""
        ...

    @abstractmethod
    def check_connection(self) -> bool:
        """Check if API key is configured and client can connect."""
        ...

    async def generate_stream(self, prompt: str) -> AsyncIterator[str]:
        """Yield text chunks. Default fallback: single yield of full response."""
        text = await self.generate(prompt)
        yield text


# Provider-native sentinels that mean "stopped because we hit max_tokens".
# Any other finish_reason (STOP / end_turn / content_filter / SAFETY / etc.)
# is treated as a non-truncation completion.
_TRUNCATION_FINISH_REASONS = {
    "MAX_TOKENS",       # Gemini
    "max_tokens",       # Anthropic
    "length",           # OpenAI / DeepSeek
}


def _is_truncated(finish_reason: Optional[str]) -> bool:
    return bool(finish_reason) and str(finish_reason) in _TRUNCATION_FINISH_REASONS


# When a generate() call returns truncated, this map suggests a higher-capacity
# alternative. Match is by (case-insensitive) substring on the model name so
# Gemini snapshot variants ("gemini-3-pro-preview-0925", etc.) all hit the same
# row. Matched in order — first hit wins, so put more specific keys first.
# `None` means "no obvious upgrade in the same provider"; the caller should
# tell the user to reduce K (cluster count) or split the report instead.
_MODEL_UPGRADE_SUGGESTIONS: list[tuple[str, Optional[str], str]] = [
    # (substring match, suggested next model, human-readable rationale)
    ("gemini-2.5-flash",   "gemini-2.5-pro",        "2.5 Pro raises the output cap from 8K to 65K tokens."),
    ("gemini-2.0-flash",   "gemini-2.5-pro",        "Newer Pro tier raises the output cap to 65K tokens."),
    ("gemini-1.5-flash",   "gemini-1.5-pro",        "1.5 Pro raises the output cap from 8K to 8K (with longer context)."),
    ("gemini-2.5-pro",     "gemini-3-pro-preview",  "3 Pro Preview keeps the high output cap and reasons more deeply."),
    ("gemini-3-pro",       None,                     "Already on top-tier Gemini. Try reducing the cluster count K, or split the report into two halves."),
    ("gpt-4o-mini",        "gpt-4o",                "GPT-4o doubles the output cap (16K) and handles long structured outputs better."),
    ("gpt-4o",             None,                     "Already on GPT-4o. Try reducing the cluster count K, or split the report into two halves."),
    ("claude-haiku",       "claude-sonnet-4",       "Sonnet 4 raises the output cap from 8K to 64K tokens."),
    ("claude-sonnet",      None,                     "Already on Claude Sonnet 4 (64K output). Try reducing the cluster count K."),
    ("deepseek-chat",      "deepseek-reasoner",     "DeepSeek Reasoner has a higher output budget for structured reports."),
]


def suggest_model_upgrade(current_model: str) -> tuple[Optional[str], str]:
    """Return (recommended_model, rationale) for the given model.

    ``recommended_model`` is None when the user is already on the top tier;
    in that case ``rationale`` explains an alternative remedy (typically
    reducing K). Returns ``(None, generic message)`` for unknown models.
    """
    if not current_model:
        return None, "Try a higher-output-token model, or reduce the cluster count K."
    needle = current_model.lower()
    for key, target, rationale in _MODEL_UPGRADE_SUGGESTIONS:
        if key in needle:
            return target, rationale
    return None, "Try a higher-output-token model, or reduce the cluster count K."


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------

class GeminiLLM(LLMClient):
    provider = "gemini"

    def __init__(self, api_key: str, model: str = "gemini-2.5-flash"):
        self.api_key = api_key
        self.model = model
        self._client = None

    def _get_client(self):
        if self._client is None:
            from google import genai
            self._client = genai.Client(api_key=self.api_key)
        return self._client

    async def generate(self, prompt: str) -> str:
        import asyncio
        from google.genai import types as genai_types

        client = self._get_client()
        # v4 / Module 13 — explicit max_output_tokens. Without this Gemini's
        # default cap (1024 tokens for some models, 8192 for newer ones) is
        # the silent reason long reports get truncated mid-section. Set to
        # the provider hard cap so 8-cluster × 3-strategy reports finish.
        config = genai_types.GenerateContentConfig(
            max_output_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
        )
        # 5-min hard timeout so a hung Gemini call can't block the request forever.
        try:
            response = await asyncio.wait_for(
                asyncio.to_thread(
                    client.models.generate_content,
                    model=self.model,
                    contents=prompt,
                    config=config,
                ),
                timeout=300.0,  # 5 minutes
            )
        except asyncio.TimeoutError as e:
            logger.error(f"Gemini call timed out after 300s for model={self.model}")
            raise RuntimeError(f"Gemini API call timed out (5 min). Check network/proxy or VPN to generativelanguage.googleapis.com") from e
        # Capture finish-reason / token usage for truncation detection. Reset
        # to defaults first so a flaky candidate / missing usage doesn't leak
        # values from the previous call.
        self.last_finish_reason = None
        self.last_truncated = False
        self.last_output_tokens = None
        try:
            cand = (response.candidates or [None])[0]
            if cand is not None:
                fr = getattr(cand, "finish_reason", None)
                # Gemini's enum stringifies to "FinishReason.MAX_TOKENS" or "MAX_TOKENS"
                # depending on SDK version — normalize.
                fr_str = getattr(fr, "name", str(fr) if fr is not None else None)
                self.last_finish_reason = fr_str
                self.last_truncated = _is_truncated(fr_str)
            usage = getattr(response, "usage_metadata", None)
            if usage is not None:
                self.last_output_tokens = (
                    getattr(usage, "candidates_token_count", None)
                    or getattr(usage, "total_token_count", None)
                )
        except Exception:  # pragma: no cover — diagnostic capture must not break flow
            logger.debug("Gemini finish-reason capture failed", exc_info=True)
        # Safely extract text — thinking models may have no text part
        try:
            return response.text or ""
        except (ValueError, AttributeError):
            for candidate in (response.candidates or []):
                parts = getattr(candidate, "content", None)
                if parts:
                    texts = [p.text for p in (parts.parts or []) if hasattr(p, "text") and p.text]
                    if texts:
                        return "\n".join(texts)
            return ""

    async def generate_stream(self, prompt: str) -> AsyncIterator[str]:
        from google.genai import types as genai_types
        client = self._get_client()
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()
        config = genai_types.GenerateContentConfig(
            max_output_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
        )

        def _produce():
            try:
                for chunk in client.models.generate_content_stream(
                    model=self.model, contents=prompt, config=config,
                ):
                    text = ""
                    try:
                        text = chunk.text or ""
                    except (ValueError, AttributeError):
                        for cand in (chunk.candidates or []):
                            parts = getattr(cand, "content", None)
                            if parts:
                                texts = [p.text for p in (parts.parts or [])
                                         if hasattr(p, "text") and p.text]
                                if texts:
                                    text = "".join(texts)
                    if text:
                        loop.call_soon_threadsafe(queue.put_nowait, text)
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, exc)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        loop.run_in_executor(None, _produce)
        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            yield item

    def check_connection(self) -> bool:
        if not self.api_key:
            logger.warning("Gemini: API key is empty")
            return False
        try:
            self._get_client()
            return True
        except Exception as e:
            logger.error("Gemini check_connection failed: %s", e)
            return False


# ---------------------------------------------------------------------------
# OpenAI (also used for DeepSeek via custom base_url)
# ---------------------------------------------------------------------------

class OpenAILLM(LLMClient):
    provider = "openai"

    def __init__(self, api_key: str, model: str = "gpt-4o", base_url: Optional[str] = None):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url
        self._client = None

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI
            kwargs = {"api_key": self.api_key}
            if self.base_url:
                kwargs["base_url"] = self.base_url
            self._client = OpenAI(**kwargs)
        return self._client

    async def generate(self, prompt: str) -> str:
        import asyncio

        def _call():
            client = self._get_client()
            response = client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
            )
            # Capture finish-reason / usage for truncation detection.
            self.last_finish_reason = None
            self.last_truncated = False
            self.last_output_tokens = None
            try:
                choice = response.choices[0]
                fr = getattr(choice, "finish_reason", None)
                self.last_finish_reason = fr
                self.last_truncated = _is_truncated(fr)
                usage = getattr(response, "usage", None)
                if usage is not None:
                    self.last_output_tokens = getattr(usage, "completion_tokens", None)
            except Exception:  # pragma: no cover
                logger.debug("OpenAI finish-reason capture failed", exc_info=True)
            return response.choices[0].message.content or ""

        return await asyncio.to_thread(_call)

    async def generate_stream(self, prompt: str) -> AsyncIterator[str]:
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def _produce():
            try:
                client = self._get_client()
                response = client.chat.completions.create(
                    model=self.model,
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
                    stream=True,
                )
                for chunk in response:
                    text = chunk.choices[0].delta.content if chunk.choices else ""
                    if text:
                        loop.call_soon_threadsafe(queue.put_nowait, text)
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, exc)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        loop.run_in_executor(None, _produce)
        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            yield item

    def check_connection(self) -> bool:
        if not self.api_key:
            logger.warning("OpenAI: API key is empty")
            return False
        try:
            self._get_client()
            return True
        except Exception as e:
            logger.error("OpenAI check_connection failed: %s", e)
            return False


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------

class AnthropicLLM(LLMClient):
    provider = "anthropic"

    def __init__(self, api_key: str, model: str = "claude-sonnet-4-20250514"):
        self.api_key = api_key
        self.model = model
        self._client = None

    def _get_client(self):
        if self._client is None:
            from anthropic import Anthropic
            self._client = Anthropic(api_key=self.api_key)
        return self._client

    async def generate(self, prompt: str) -> str:
        import asyncio

        def _call():
            client = self._get_client()
            # Why streaming under the hood:
            #
            # The Anthropic SDK refuses non-streaming `messages.create()`
            # whenever max_tokens is large enough that the request could
            # theoretically take longer than 10 minutes. Concretely the
            # error surfaces as:
            #
            #   "Streaming is required for operations that may take longer
            #    than 10 minutes. See https://github.com/anthropics/
            #    anthropic-sdk-python#long-requests for more details"
            #
            # We use `max_tokens=DEFAULT_MAX_OUTPUT_TOKENS` (32K) so that
            # long AI reports / design strategies don't get silently
            # truncated mid-section — which means we hit the streaming-
            # required wall on every report generation, every design
            # strategy call, and every chart summary the moment Anthropic
            # is the active provider.
            #
            # Fix: call `messages.stream()` internally, accumulate the
            # text chunks, and return the joined string. The caller's
            # contract (blocking call → full text back) is preserved, so
            # ReportService / DesignEngine / ChartSummaryService don't
            # need to know we changed transport. `get_final_message()`
            # gives us the same stop_reason / usage info we used to read
            # off the non-streaming `response` object, so truncation
            # detection still works.
            chunks: list[str] = []
            final_message = None
            with client.messages.stream(
                model=self.model,
                max_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
                messages=[{"role": "user", "content": prompt}],
            ) as stream:
                for text in stream.text_stream:
                    if text:
                        chunks.append(text)
                # Must be called inside the `with` block (the SDK closes
                # the underlying HTTP stream on exit). Safe even when the
                # stream emitted no text — returns a Message with the
                # error / stop_reason set.
                try:
                    final_message = stream.get_final_message()
                except Exception:
                    logger.debug("Anthropic get_final_message failed", exc_info=True)

            # Capture stop_reason / usage for truncation detection.
            self.last_finish_reason = None
            self.last_truncated = False
            self.last_output_tokens = None
            if final_message is not None:
                try:
                    fr = getattr(final_message, "stop_reason", None)
                    self.last_finish_reason = fr
                    self.last_truncated = _is_truncated(fr)
                    usage = getattr(final_message, "usage", None)
                    if usage is not None:
                        self.last_output_tokens = getattr(usage, "output_tokens", None)
                except Exception:  # pragma: no cover
                    logger.debug("Anthropic stop-reason capture failed", exc_info=True)

            return "".join(chunks)

        return await asyncio.to_thread(_call)

    async def generate_stream(self, prompt: str) -> AsyncIterator[str]:
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def _produce():
            try:
                client = self._get_client()
                with client.messages.stream(
                    model=self.model,
                    max_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
                    messages=[{"role": "user", "content": prompt}],
                ) as stream:
                    for text in stream.text_stream:
                        if text:
                            loop.call_soon_threadsafe(queue.put_nowait, text)
            except Exception as exc:
                loop.call_soon_threadsafe(queue.put_nowait, exc)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        loop.run_in_executor(None, _produce)
        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            yield item

    def check_connection(self) -> bool:
        if not self.api_key:
            logger.warning("Anthropic: API key is empty")
            return False
        try:
            self._get_client()
            return True
        except Exception as e:
            logger.error("Anthropic check_connection failed: %s", e)
            return False


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def create_llm_client(
    provider: str, api_key: str, model: str, **kwargs
) -> LLMClient:
    """Create an LLM client for the given provider."""
    if provider == "gemini":
        return GeminiLLM(api_key, model)
    if provider == "openai":
        return OpenAILLM(api_key, model)
    if provider == "anthropic":
        return AnthropicLLM(api_key, model)
    if provider == "deepseek":
        return OpenAILLM(api_key, model, base_url="https://api.deepseek.com")
    raise ValueError(f"Unknown LLM provider: {provider}")
