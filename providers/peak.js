/* Peak-hours traffic-light logic, shared across providers.
 *
 * Each provider defines its own peak windows as a list of [startHour, endHour)
 * intervals in UTC (24h) and attaches them to its `peakstatus` menu entry via
 * the `peakWindows` field. currentPeakStatus() reports whether "now" falls in a
 * peak window and the time remaining until the next state change, so the menu
 * can render a colored dot + live countdown that matches the provider's billing
 * schedule regardless of the user's local timezone. */

/* Current peak status at "now": whether we're in a peak window and ms
 * remaining until the next state change (peak→off or off→peak).
 *
 * `windows` is a list of [startHour, endHour) intervals in UTC (24h). The
 * countdown is the nearest window boundary (any start or end) strictly after
 * the current fractional hour; if none remains today, it wraps to the earliest
 * boundary tomorrow (+24h). */
export function currentPeakStatus(now = new Date(), windows = []) {
    const hour = now.getUTCHours();
    const min = now.getUTCMinutes();
    const sec = now.getUTCSeconds();
    // Fractional hour within the UTC day.
    const fracHour = hour + min / 60 + sec / 3600;

    const inPeak = windows.some(([s, e]) => fracHour >= s && fracHour < e);

    const bounds = new Set();
    for (const [s, e] of windows) { bounds.add(s); bounds.add(e); }
    const sorted = [...bounds].sort((a, b) => a - b);

    let next = null;
    for (const b of sorted) {
        if (b > fracHour) { next = b; break; }
    }
    if (next === null) next = sorted[0] + 24;

    const msToChange = Math.max(0, Math.round((next - fracHour) * 3600000));
    return { inPeak, msToChange };
}
