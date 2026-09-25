/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      /**
       * Type scale. Every size is routed through --font-scale (declared in
       * index.css, default 1) so a single variable drives the whole app's
       * text size — see the Text size control in Settings.
       *
       * Rules:
       *  - No component may use an arbitrary `text-[NNpx]` value. Those do
       *    not scale, which is the bug this replaces.
       *  - Line heights are unitless on purpose: a fixed rem/px leading
       *    would not grow with the font and lines would collide at 2x.
       *  - The floor is 13px. Apple HIG's minimum is 11pt and Material's
       *    body minimum is 12sp; nothing here goes under either.
       */
      fontSize: {
        xs: ["calc(13px * var(--font-scale))", { lineHeight: "1.35" }],
        sm: ["calc(14px * var(--font-scale))", { lineHeight: "1.43" }],
        base: ["calc(16px * var(--font-scale))", { lineHeight: "1.5" }],
        body: ["calc(17px * var(--font-scale))", { lineHeight: "1.55" }],
        lg: ["calc(19px * var(--font-scale))", { lineHeight: "1.5" }],
        xl: ["calc(21px * var(--font-scale))", { lineHeight: "1.4" }],
        "2xl": ["calc(24px * var(--font-scale))", { lineHeight: "1.33" }],
        "3xl": ["calc(30px * var(--font-scale))", { lineHeight: "1.2" }],
      },
      colors: {
        paper: "#FAF6EF",
        surface: "#FFFFFF",
        ink: "#1F1B16",
        muted: "#6E6659",
        moss: {
          DEFAULT: "#3D5A44",
          soft: "#3D5A441A",
          deep: "#2C4232",
        },
        rust: {
          DEFAULT: "#A4552E",
          soft: "#A4552E1A",
        },
        hairline: "#E7DFD2",
      },
      fontFamily: {
        display: ["'Cormorant Garamond'", "Georgia", "serif"],
        body: ["'Source Sans 3'", "system-ui", "sans-serif"],
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        rise: "rise 420ms cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [],
};
