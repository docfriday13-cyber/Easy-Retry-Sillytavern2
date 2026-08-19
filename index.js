// Mini Retry — a minimal, purpose-built replacement for fetch-retry.
//
// Design goals, based on observed behavior of this specific API:
//   - Failures are FAST (a bad attempt resolves in ~1-2s), so there's no need
//     to wait between retries. No exponential backoff.
//   - Successes can legitimately take up to ~a minute, so we don't want to
//     cut those off early.
//   - The response body is NEVER read/buffered here. The original bug in
//     fetch-retry came from awaiting the full streamed body before deciding
//     whether to hand the response back to SillyTavern, which could block
//     forever with no timeout. This version only ever looks at response.ok
//     and response.status (both available immediately, no waiting on body),
//     then passes the live, unread response straight through so SillyTavern
//     streams it normally.
//
// IMPORTANT: uninstall/remove the old "Fetch Retry" extension before
// installing this one. Running two fetch-patching extensions at once will
// conflict with each other.

(function () {
    'use strict';

    // ---- Tune these three numbers to match your API's behavior ----
    const MAX_ATTEMPTS = 40;          // total attempts before giving up and surfacing the error
    const RETRY_DELAY_MS = 500;       // pause between attempts — keep this LOW, the API fails fast
    const ATTEMPT_TIMEOUT_MS = 90000; // if a single attempt hangs longer than this, abort it and retry
    // ------------------------------------------------------------------

    if (window._miniRetryPatched) {
        console.warn('[Mini Retry] Already patched, skipping.');
        return;
    }
    window._miniRetryPatched = true;

    const originalFetch = window.fetch;

    function isGenerationUrl(url) {
        if (typeof url !== 'string') return false;
        return url.includes('/api/backends/chat-completions/generate')
            || url.includes('/api/backends/text-completions/generate')
            || url.includes('/api/backends/kobold/generate')
            || url.includes('/api/generate')
            || (url.includes('generate') && !url.includes('generate-image') && !url.includes('caption'));
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    window.fetch = async function (...args) {
        const urlArg = args[0];
        const url = urlArg instanceof Request ? urlArg.url : urlArg;

        if (!isGenerationUrl(url)) {
            return originalFetch.apply(this, args);
        }

        const originalInit = args[1] || {};
        const userSignal = urlArg instanceof Request ? urlArg.signal : originalInit.signal;

        if (userSignal?.aborted) {
            return originalFetch.apply(this, args);
        }

        for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
            if (userSignal?.aborted) {
                throw new DOMException('Aborted by user', 'AbortError');
            }

            const attemptController = new AbortController();
            const onUserAbort = () => attemptController.abort();
            userSignal?.addEventListener('abort', onUserAbort);
            const perAttemptTimer = setTimeout(() => attemptController.abort(), ATTEMPT_TIMEOUT_MS);

            try {
                const init = { ...originalInit, signal: attemptController.signal };
                const response = await originalFetch(urlArg instanceof Request ? urlArg : url, init);

                clearTimeout(perAttemptTimer);
                userSignal?.removeEventListener('abort', onUserAbort);

                if (response.ok) {
                    return response; // success — hand back the live, unread response as-is
                }

                if (response.status === 429 || response.status >= 500) {
                    console.warn(`[Mini Retry] Attempt ${attempt + 1}/${MAX_ATTEMPTS + 1} got HTTP ${response.status}, retrying...`);
                    if (attempt < MAX_ATTEMPTS) {
                        await sleep(RETRY_DELAY_MS);
                        continue;
                    }
                }

                return response; // definitive error (e.g. 400/401) or attempts exhausted — let ST show it

            } catch (err) {
                clearTimeout(perAttemptTimer);
                userSignal?.removeEventListener('abort', onUserAbort);

                if (userSignal?.aborted) {
                    // Real user cancel — propagate immediately, never retry this.
                    throw new DOMException('Aborted by user', 'AbortError');
                }

                console.warn(`[Mini Retry] Attempt ${attempt + 1}/${MAX_ATTEMPTS + 1} failed (${err.message}), retrying...`);

                if (attempt >= MAX_ATTEMPTS) {
                    throw err;
                }
                await sleep(RETRY_DELAY_MS);
            }
        }
    };

    console.log(`[Mini Retry] Installed. Max attempts: ${MAX_ATTEMPTS}, delay: ${RETRY_DELAY_MS}ms, per-attempt timeout: ${ATTEMPT_TIMEOUT_MS}ms`);
})();
