/**
 * Minimal OpenRouter client — https://openrouter.ai/api/v1/chat/completions.
 *
 * Framework-agnostic on purpose: no Firebase/Firestore/logger imports, so any
 * future callable that needs a model call can reuse `callOpenRouter` without
 * pulling in aiSmartAdd's domain error codes. Callers map `OpenRouterServiceError`
 * onto their own error shape (see aiSmartAdd.js's `callAiModel`).
 */

const OPENROUTER_BASE_URL = process.env.OPEN_ROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

// No OpenRouter model had been chosen for this project before this integration.
// openai/gpt-4o-mini is the default: cheap, fast, and one of the few OpenRouter
// models with reliable `response_format: { type: 'json_object' }` support, which
// aiSmartAdd.js's structured parsing depends on. Override with OPEN_ROUTER_MODEL
// in functions/.env to use a different model.
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

class OpenRouterServiceError extends Error {
    constructor(code, message, extra = {}) {
        super(message || code);
        this.name = 'OpenRouterServiceError';
        this.code = code;
        Object.assign(this, extra);
    }
}

/**
 * @param {object} params
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {string} [params.model] Defaults to OPEN_ROUTER_MODEL env var, then DEFAULT_MODEL.
 * @param {number} [params.temperature]
 * @param {object|null} [params.responseFormat] e.g. { type: 'json_object' }
 * @returns {Promise<{content: string, model: string, raw: object}>}
 */
const callOpenRouter = async ({
    messages,
    model,
    temperature = 0.1,
    responseFormat = null,
} = {}) => {
    const apiKey = process.env.OPEN_ROUTER_KEY;
    if (!apiKey) {
        throw new OpenRouterServiceError('NOT_CONFIGURED', 'OpenRouter API key is not configured.');
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new OpenRouterServiceError('INVALID_REQUEST', 'messages must be a non-empty array.');
    }

    const resolvedModel = model || process.env.OPEN_ROUTER_MODEL || DEFAULT_MODEL;

    const body = { model: resolvedModel, messages, temperature };
    if (responseFormat) body.response_format = responseFormat;

    let response;
    try {
        response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
    } catch (err) {
        throw new OpenRouterServiceError('REQUEST_FAILED', 'OpenRouter request failed.', {
            cause: err && err.message,
        });
    }

    if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const detail = { status: response.status, bodySnippet: bodyText.slice(0, 300) };

        if (response.status === 401 || response.status === 403) {
            throw new OpenRouterServiceError('AUTH_FAILED', 'OpenRouter rejected the API key.', detail);
        }
        if (response.status === 429) {
            throw new OpenRouterServiceError('RATE_LIMITED', 'OpenRouter rate limit exceeded.', detail);
        }
        throw new OpenRouterServiceError('REQUEST_FAILED', 'OpenRouter returned an error response.', detail);
    }

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new OpenRouterServiceError('INVALID_RESPONSE', 'OpenRouter returned malformed JSON.');
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new OpenRouterServiceError('EMPTY_RESPONSE', 'OpenRouter returned an empty response.');
    }

    return { content, model: payload.model || resolvedModel, raw: payload };
};

module.exports = { callOpenRouter, OpenRouterServiceError, DEFAULT_MODEL };
