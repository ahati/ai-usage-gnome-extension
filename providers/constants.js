/* Shared constants for provider HTTP requests.
 *
 * All providers send the same browser-like User-Agent so that dashboard-style
 * endpoints (OpenCode Go SSR, DeepSeek platform, …) treat the requests like
 * regular web traffic. Centralized here so a single edit updates every
 * provider. */

export const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
