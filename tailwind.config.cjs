module.exports = {
  "content": [
    "./views/**/*.ejs",
    "./public/app.js"
  ],
  "theme": {
    "extend": {
      "fontFamily": {
        "sans": [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif"
        ],
        "mono": [
          "JetBrains Mono",
          "Fira Code",
          "monospace"
        ]
      },
      "colors": {
        "brand": {
          "50": "#edf7f5",
          "100": "#d7eee8",
          "200": "#b2ded3",
          "300": "#85c8b8",
          "400": "#50ab97",
          "500": "#278874",
          "600": "#187562",
          "700": "#145d50",
          "800": "#164d43",
          "900": "#163f38",
          "950": "#0b2924"
        },
        "surface": {
          "50": "#f8fafc",
          "100": "#f1f5f9",
          "200": "#e2e8f0",
          "300": "#cbd5e1",
          "400": "#94a3b8",
          "500": "#64748b",
          "600": "#475569",
          "700": "#334155",
          "800": "#1e293b",
          "900": "#0f172a",
          "950": "#020617"
        },
        "ink": {
          "800": "#131a2b",
          "900": "#0d1424",
          "950": "#080d1a"
        },
        "accent": {
          "50": "#ecfdf5",
          "100": "#d1fae5",
          "500": "#10b981",
          "600": "#059669",
          "700": "#047857"
        }
      },
      "boxShadow": {
        "soft": "0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06)",
        "card": "0 1px 2px rgba(15,23,42,0.04), 0 12px 32px -20px rgba(15,23,42,0.25)",
        "elevated": "0 24px 60px -30px rgba(15,23,42,0.35)",
        "glow": "0 0 40px -12px rgba(79,70,229,0.45)"
      }
    }
  }
};
