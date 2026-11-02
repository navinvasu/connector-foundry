/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Deep-space navy surfaces (command-center theme)
        ink: {
          950: '#04070e',
          900: '#060b16',
          850: '#080f1d',
          800: '#0a1220',
          700: '#0e1729',
          600: '#142036',
        },
        neon: {
          DEFAULT: '#ffa02e',
          dim: '#e07b12',
        },
        // Keep `brand` as an alias so existing classes keep working; maps to neon orange.
        brand: {
          50:  '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316',
          600: '#ea580c',
          700: '#c2410c',
          900: '#7c2d12',
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        ticker: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        ticker: 'ticker 32s linear infinite',
        pulseDot: 'pulseDot 1.6s ease-in-out infinite',
      },
      boxShadow: {
        glow: '0 0 24px rgba(255, 160, 46, 0.28)',
        card: '0 8px 32px rgba(0, 0, 0, 0.45)',
      },
    },
  },
  plugins: [],
};
