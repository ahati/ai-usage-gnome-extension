/* Chart rendering — Cairo-drawn bar charts, progress bars, legends.
 *
 * Extracted from extension.js to keep the Indicator class focused on
 * menu lifecycle, tab management, and fetch orchestration.
 *
 * All functions are stateless: they take a parent St.Widget and an entry
 * descriptor, build the widget sub-tree, and attach repaint handlers.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import { hexToRgba, fmtNum, fmtCost } from './providers/utils.js';

/* ── Cairo helpers ── */

/* Rounded-rectangle subpath covering the full widget area. */
export function roundedPath(cr, w, h, radius) {
    cr.newSubPath();
    cr.arc(w - radius, radius, radius, -Math.PI / 2, 0);
    cr.arc(w - radius, h - radius, radius, 0, Math.PI / 2);
    cr.arc(radius, h - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(radius, radius, radius, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

/* ── Small widgets ── */

function addTitle(parent, text) {
    parent.add_child(new St.Label({
        text,
        style_class: 'ai-usage-usage-title',
    }));
}

/* 10×10 Cairo-filled square colored to match a model segment. */
export function legendSwatch(color) {
    const swatch = new St.DrawingArea({
        style_class: 'ai-usage-legend-swatch',
    });
    swatch.connect('repaint', area => {
        const cr = area.get_context();
        const w = area.width;
        const h = area.height;
        if (w <= 0 || h <= 0) { cr.$dispose(); return; }
        const rgba = hexToRgba(color);
        cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        cr.$dispose();
    });
    return swatch;
}

/* Build a legend entry label, accounting for unit. */
function legendLabel(m, unit) {
    if (m.total === null || m.total === undefined) return m.name;
    if (unit === 'cost') return `${m.name} ${fmtCost(m.total)}`;
    return `${m.name} ${fmtNum(m.total)}`;
}

/* ── Legend (flow layout) ── */

/* Render a legend as a wrapping flow layout: items are packed into horizontal
 * rows of at most `perRow` swatch+label pairs, then rows stack vertically. */
export function addLegendFlow(parent, items, unit, perRow = 4) {
    if (!items || items.length === 0) return;
    const container = new St.BoxLayout({
        style_class: 'ai-usage-legend-flow',
        vertical: true,
        x_expand: true,
    });
    for (let i = 0; i < items.length; i += perRow) {
        const row = new St.BoxLayout({
            style_class: 'ai-usage-legend-row',
            x_expand: true,
        });
        for (let j = i; j < Math.min(i + perRow, items.length); j++) {
            const item = items[j];
            row.add_child(legendSwatch(item.color));
            const text = item.label ?? legendLabel(item, unit);
            row.add_child(new St.Label({
                text,
                style_class: 'ai-usage-legend-label',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        container.add_child(row);
    }
    parent.add_child(container);
}

/* ── X-axis label row (shared by bar chart and stacked bar chart) ── */

/* Build a horizontal row of labels. Thin labels for dense charts (24h/30d)
 * so they don't overlap — show every Nth label via `step`. */
function buildLabelRow(parent, labels, step) {
    const labelRow = new St.BoxLayout({
        x_expand: true,
        style_class: 'ai-usage-barchart-labels',
    });
    for (let i = 0; i < labels.length; i++) {
        labelRow.add_child(new St.Label({
            text: (i % step === 0 || i === labels.length - 1) ? labels[i] : '',
            style_class: 'ai-usage-barchart-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        }));
    }
    parent.add_child(labelRow);
}

/* ── Progress bar ── */

/* One horizontal progress bar. pctUsed/pctRemaining are 0–100.
 * fillColor is a #RRGGBB string (computed by the caller via usageColor). */
export function addProgressBar(parent, pctUsed, pctRemaining, fillColor) {
    const fraction = Math.max(0, Math.min(100, pctRemaining)) / 100;

    const bar = new St.DrawingArea({
        style_class: 'ai-usage-progress-bar',
        x_expand: true,
    });
    bar.connect('repaint', area => {
        const cr = area.get_context();
        const w = area.width;
        const h = area.height;
        if (w <= 0 || h <= 0) { cr.$dispose(); return; }
        const radius = Math.min(h / 2, 6);

        // Translucent track background (rounded)
        cr.setSourceRGBA(1, 1, 1, 0.1);
        roundedPath(cr, w, h, radius);
        cr.fill();

        // Colored fill (left-aligned, width = fraction of track, rounded)
        if (fraction > 0 && fillColor) {
            const fillW = Math.round(w * fraction);
            const rgba = hexToRgba(fillColor);
            cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
            cr.save();
            roundedPath(cr, w, h, radius);
            cr.clip();
            cr.rectangle(0, 0, fillW, h);
            cr.fill();
            cr.restore();
        }
        cr.$dispose();
    });
    parent.add_child(bar);
    return bar;
}

/* ── Bar chart (vertical bars) ── */

export function addBarChart(parent, e) {
    const bars = e.bars || [];
    if (bars.length === 0) return;
    const maxVal = Math.max(...bars.map(b => b.value), 1);

    addTitle(parent, e.label || 'Usage');

    // Chart area wrapped in a styled box so empty/zero bars don't
    // blend into the popup background.
    const chartBox = new St.BoxLayout({
        style_class: 'ai-usage-chart-box',
        x_expand: true,
    });
    const chart = new St.DrawingArea({
        style_class: 'ai-usage-barchart',
        x_expand: true,
    });
    chartBox.add_child(chart);
    const defaultColor = hexToRgba('#3584e4');
    chart.connect('repaint', area => {
        const cr = area.get_context();
        const w = area.width;
        const h = area.height;
        if (w <= 0 || h <= 0 || bars.length === 0) { cr.$dispose(); return; }

        const gap = 3;
        const barW = Math.max(2, (w - gap * (bars.length - 1)) / bars.length);

        for (let i = 0; i < bars.length; i++) {
            const fraction = bars[i].value / maxVal;
            const barH = bars[i].value > 0
                ? Math.max(1, Math.round((h - 2) * fraction))
                : 0;
            const x = i * (barW + gap);
            const y = h - 2 - barH;
            const rgba = bars[i].color ? hexToRgba(bars[i].color) : defaultColor;
            cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
            if (barH > 0) {
                cr.rectangle(x, y, barW, barH);
                cr.fill();
            }
        }
        cr.$dispose();
    });
    parent.add_child(chartBox);

    // X-axis labels
    const labels = bars.map(b => b.label);
    const step = bars.length > 12 ? Math.ceil(bars.length / 6) : 1;
    buildLabelRow(parent, labels, step);

    // Optional legend
    if (e.legend)
        addLegendFlow(parent, e.legend, e.unit);
}

/* ── Stacked bar chart ── */

export function addStackedBarChart(parent, e) {
    const buckets = e.buckets || [];
    if (buckets.length === 0) return;
    const legend = e.legend || [];

    const bucketTotals = buckets.map(b =>
        b.segments.reduce((s, seg) => s + seg.value, 0));
    const maxTotal = Math.max(...bucketTotals, 1);

    addTitle(parent, e.label || 'Model usage');

    // Chart area wrapped in a styled box.
    const chartBox = new St.BoxLayout({
        style_class: 'ai-usage-chart-box',
        x_expand: true,
    });
    const chart = new St.DrawingArea({
        style_class: 'ai-usage-barchart ai-usage-stacked-barchart',
        x_expand: true,
    });
    chartBox.add_child(chart);
    chart.connect('repaint', area => {
        const cr = area.get_context();
        const w = area.width;
        const h = area.height;
        if (w <= 0 || h <= 0 || buckets.length === 0) { cr.$dispose(); return; }

        const gap = 2;
        const barW = Math.max(2, (w - gap * (buckets.length - 1)) / buckets.length);
        const chartH = h - 2;   // minimal bottom clearance

        for (let i = 0; i < buckets.length; i++) {
            const total = bucketTotals[i];
            if (total <= 0) continue;
            const scale = chartH / maxTotal;
            const x = i * (barW + gap);
            let y = chartH;
            for (const seg of buckets[i].segments) {
                if (seg.value <= 0) continue;
                const segH = Math.max(1, Math.round(seg.value * scale));
                y -= segH;
                const rgba = hexToRgba(seg.color);
                cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
                cr.rectangle(x, y, barW, segH);
                cr.fill();
            }
        }
        cr.$dispose();
    });
    parent.add_child(chartBox);

    // X-axis labels
    const labels = buckets.map(b => b.label);
    const step = buckets.length > 12 ? Math.ceil(buckets.length / 6) : 1;
    buildLabelRow(parent, labels, step);

    // Legend
    if (legend.length > 0)
        addLegendFlow(parent, legend, e.unit);
}

/* ── Cost distribution bar ── */

export function addCostDistribution(parent, e) {
    const segments = e.segments || [];
    if (segments.length === 0) return;
    const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;

    addTitle(parent, e.label || 'Cost distribution');

    const bar = new St.DrawingArea({
        style_class: 'ai-usage-progress-bar ai-usage-cost-dist-bar',
        x_expand: true,
    });
    bar.connect('repaint', area => {
        const cr = area.get_context();
        const w = area.width;
        const h = area.height;
        if (w <= 0 || h <= 0) { cr.$dispose(); return; }

        const radius = Math.min(h / 2, 6);

        // Translucent track background (rounded)
        cr.setSourceRGBA(1, 1, 1, 0.08);
        roundedPath(cr, w, h, radius);
        cr.fill();

        // Clip to rounded path, then draw colored segments
        cr.save();
        roundedPath(cr, w, h, radius);
        cr.clip();

        let x = 0;
        for (const seg of segments) {
            const segW = Math.round(w * seg.value / total);
            if (segW <= 0) continue;
            const rgba = hexToRgba(seg.color);
            cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
            cr.rectangle(x, 0, segW, h);
            cr.fill();
            x += segW;
        }
        cr.restore();
        cr.$dispose();
    });
    parent.add_child(bar);

    // Total cost subtitle
    const stats = new St.BoxLayout({ x_expand: true });
    stats.add_child(new St.Label({
        text: `${segments.length} models`,
        style_class: 'ai-usage-usage-subtitle',
        x_expand: true,
    }));
    stats.add_child(new St.Label({
        text: `total ${fmtCost(e.totalCost)}`,
        style_class: 'ai-usage-usage-subtitle ai-usage-usage-subtitle-right',
    }));
    parent.add_child(stats);

    // Flow legend
    addLegendFlow(parent, e.legend, e.unit);
}
