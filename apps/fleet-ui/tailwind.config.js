/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        // Semantic tokens used across the UI. Sourced from --fleet-* CSS
        // variables in index.css so we only have one place to tweak the
        // palette.
        bg: "rgb(var(--fleet-bg) / <alpha-value>)",
        surface: "rgb(var(--fleet-surface) / <alpha-value>)",
        border: "rgb(var(--fleet-border) / <alpha-value>)",
        muted: "rgb(var(--fleet-muted) / <alpha-value>)",
        text: "rgb(var(--fleet-text) / <alpha-value>)",
        accent: "rgb(var(--fleet-accent) / <alpha-value>)",
        "accent-soft": "rgb(var(--fleet-accent-soft) / <alpha-value>)",
        ok: "rgb(var(--fleet-ok) / <alpha-value>)",
        warn: "rgb(var(--fleet-warn) / <alpha-value>)",
        danger: "rgb(var(--fleet-danger) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};
