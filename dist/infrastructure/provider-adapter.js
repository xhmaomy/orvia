class PassthroughProviderAdapter {
    type;
    constructor(type) {
        this.type = type;
    }
    validate(configuration) {
        if (!configuration.model.trim())
            throw new Error('Provider model is required');
        if (configuration.type !== this.type)
            throw new Error(`Provider adapter mismatch: ${configuration.type}`);
    }
}
const adapters = new Map();
export function providerAdapter(type) {
    const normalized = type.trim().toLowerCase();
    const existing = adapters.get(normalized);
    if (existing)
        return existing;
    const adapter = new PassthroughProviderAdapter(normalized);
    adapters.set(normalized, adapter);
    return adapter;
}
export function providerApiKey(type) {
    const normalized = type.trim().toLowerCase();
    const value = normalized === 'openai'
        ? process.env.OPENAI_API_KEY
        : normalized === 'anthropic'
            ? process.env.ANTHROPIC_API_KEY
            : undefined;
    return value?.trim() || undefined;
}
export function httpProviderReady(type) {
    return (type.trim().toLowerCase() === 'openai' || type.trim().toLowerCase() === 'anthropic') && Boolean(providerApiKey(type));
}
export async function completeProviderChat(input) {
    const type = input.type.trim().toLowerCase();
    const apiKey = input.apiKey?.trim() || providerApiKey(type);
    if (!apiKey)
        throw new Error(`Missing API key for provider ${type}`);
    const fetchImpl = input.fetchImpl ?? fetch;
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? 120_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    if (type === 'openai') {
        const base = (input.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '');
        const response = await fetchImpl(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            signal,
            body: JSON.stringify({
                model: input.model,
                messages: [
                    ...(input.systemPrompt ? [{ role: 'system', content: input.systemPrompt }] : []),
                    { role: 'user', content: input.prompt },
                ],
            }),
        });
        if (!response.ok)
            throw new Error(`OpenAI request failed: ${response.status}`);
        const body = await response.json();
        const text = body.choices?.[0]?.message?.content;
        if (!text)
            throw new Error('OpenAI response did not include message content');
        return text;
    }
    if (type === 'anthropic') {
        const base = (input.baseUrl?.trim() || 'https://api.anthropic.com').replace(/\/$/, '');
        const response = await fetchImpl(`${base}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            signal,
            body: JSON.stringify({
                model: input.model,
                max_tokens: 4096,
                ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
                messages: [{ role: 'user', content: input.prompt }],
            }),
        });
        if (!response.ok)
            throw new Error(`Anthropic request failed: ${response.status}`);
        const body = await response.json();
        const text = body.content?.map((item) => item.text ?? '').join('');
        if (!text)
            throw new Error('Anthropic response did not include text content');
        return text;
    }
    throw new Error(`Provider ${type} has no HTTP client`);
}
