/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
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
