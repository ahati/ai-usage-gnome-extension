/* 32-color preset for model series. Assigned by index in sortOrder, so the
 * same model gets the same color across charts within a session. Tuned for
 * distinguishability on a dark popup background. Shared across all providers
 * (Z.AI, OpenCode Go, …) for a consistent look. */

export const MODEL_COLORS = [
    '#3584e4', // 1  blue
    '#9141ac', // 2  purple
    '#26a269', // 3  teal
    '#e01b24', // 4  red
    '#986a44', // 5  brown
    '#f6d32d', // 6  yellow
    '#ff7800', // 7  orange
    '#33d17a', // 8  light green
    '#1c71d8', // 9  darker blue
    '#813d9c', // 10 dark purple
    '#1a5fb4', // 11 navy
    '#c01c28', // 12 dark red
    '#7a8c2e', // 13 olive
    '#e5a50a', // 14 amber
    '#ed333b', // 15 bright red
    '#62a0ea', // 16 light blue
    '#c8557e', // 17 pink
    '#5e8a4e', // 18 forest green
    '#d48b3a', // 19 tan
    '#4a86b8', // 20 steel blue
    '#b161c4', // 21 light purple
    '#2e859a', // 22 cyan
    '#c04a6c', // 23 rose
    '#8a6d3b', // 24 dark tan
    '#5f3c8e', // 25 indigo
    '#3a8f5f', // 26 emerald
    '#b8542a', // 27 rust
    '#6987c4', // 28 periwinkle
    '#a04668', // 29 maroon
    '#4d6b8a', // 30 slate
    '#9c6b3f', // 31 copper
    '#5a7d3a', // 32 moss
];

/* Assign a color to a model by index. `modelName` is accepted for signature
 * stability but only the index is used (positional coloring). */
export function modelColor(modelName, index) {
    return MODEL_COLORS[index % MODEL_COLORS.length];
}
