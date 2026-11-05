/** @type {import('tailwindcss').Config} */
// ATOM design tokens. Every colour is a space-separated RGB triplet in a CSS variable (--c-*) defined
// in src/index.css, so a [data-theme] block can swap the whole palette and `bg-primary/40` still works.
const c = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx}', '../shared/**/*.json'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: c('primary'),
          dark: c('primary-dark'),
          light: c('primary-light'),
          muted: 'rgb(var(--c-primary) / 0.08)',
          tint: c('primary-tint'),
          border: 'rgb(var(--c-primary-border) / 0.2)',
        },
        gold: { DEFAULT: c('gold'), light: c('gold-light'), dark: c('gold-dark'), muted: c('gold-muted'), on: c('gold-on') },
        cream: { DEFAULT: c('cream'), dark: c('cream-dark') },
        // `primary` is for backgrounds that carry white text (header, sidebar, buttons). `brand` is the same
        // colour for text, borders, rings and accents on page/card backgrounds: identical in the light themes,
        // lighter in the dark ones so it stays readable.
        brand: { DEFAULT: c('brand'), dark: c('brand-dark') },
        // Cards, inputs, menus: white in the light themes, a raised dark panel in the dark ones.
        // (`white` itself stays pure white for text/overlays on the coloured sidebar and header.)
        surface: c('surface'),
        brown: c('brown'),
        charcoal: c('charcoal'),
        line: { DEFAULT: c('line'), dark: c('line-dark') },
        ink: { DEFAULT: c('ink'), 2: c('ink-2'), 3: c('ink-3'), 'on-primary': 'rgba(255,255,255,0.85)' },
        success: { DEFAULT: c('success'), bg: c('success-bg') },
        warning: { DEFAULT: c('warning'), bg: c('warning-bg') },
        // `solid` is the filled-button red that carries white text; `DEFAULT` is the text red.
        error: { DEFAULT: c('error'), bg: c('error-bg'), solid: c('error-solid') },
        info: { DEFAULT: c('info'), bg: c('info-bg') },
        rust: { DEFAULT: c('rust'), bg: c('rust-bg') },
        disposed: c('disposed'),
        role: {
          super: { DEFAULT: c('role-super'), bg: c('role-super-bg') },
          engineer: { DEFAULT: c('role-engineer'), bg: c('role-engineer-bg') },
          employee: { DEFAULT: c('role-employee'), bg: c('role-employee-bg') },
        },
      },
      fontFamily: {
        display: ['Amiri', 'Cormorant Garamond', 'Georgia', 'serif'],
        sans: ['Amiri', 'Inter', 'Lato', 'Helvetica', 'Arial', 'sans-serif'],
        arabic: ['Amiri', 'Kanz-al-Marjaan', 'Arial Unicode MS', 'serif'],
        ui: ['Inter', 'Amiri', 'Lato', 'Helvetica', 'Arial', 'sans-serif'],
      },
      borderRadius: { card: '12px', btn: '8px' },
      boxShadow: {
        // [PROPOSED] replace with exact values from Awraaq theme.css
        'glow-gold': '0 4px 14px rgb(var(--c-gold) / 0.35)',
        'glow-teal': '0 4px 14px rgb(var(--c-primary) / 0.30)',
      },
      minHeight: { tap: '44px' },
      minWidth: { tap: '44px' },
    },
  },
  plugins: [],
};
