/** @type {import('tailwindcss').Config} */
// ATOM design tokens (Awraaq theme). Same values are exposed as CSS variables in src/index.css.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#0F5B5A',
          dark: '#083F3E',
          light: '#17706E',
          muted: 'rgba(15,91,90,0.08)',
          tint: '#E2F0EC',
          border: 'rgba(201,168,76,0.2)',
        },
        gold: { DEFAULT: '#C9A84C', light: '#E4C97E', dark: '#A07830', muted: '#F5EDD8', on: '#3D2B1F' },
        cream: { DEFAULT: '#FAF7F2', dark: '#F0EBE0' },
        brown: '#3D2B1F',
        charcoal: '#1C1C1C',
        line: { DEFAULT: '#E0D6C8', dark: '#C8B89A' },
        ink: { DEFAULT: '#1A1A1A', 2: '#4B5563', 3: '#8C7B6B', 'on-primary': 'rgba(255,255,255,0.85)' },
        success: { DEFAULT: '#3A6B4A', bg: '#EBF4EE' },
        warning: { DEFAULT: '#8B5E1A', bg: '#FDF3E0' },
        error: { DEFAULT: '#8B2A2A', bg: '#FBEDED' },
        info: { DEFAULT: '#1A4A6B', bg: '#E8F2FB' },
        rust: { DEFAULT: '#B5561F', bg: '#FBEAE0' },
        disposed: '#2E2E2E',
        role: {
          super: { DEFAULT: '#5A1A8B', bg: '#F3EBFB' },
          engineer: { DEFAULT: '#1F6FB2', bg: '#E3F0F9' },
          employee: { DEFAULT: '#6B3A1A', bg: '#FBF0E8' },
        },
      },
      fontFamily: {
        display: ['Amiri', 'Cormorant Garamond', 'Georgia', 'serif'],
        sans: ['Amiri', 'Inter', 'Lato', 'Helvetica', 'Arial', 'sans-serif'],
        arabic: ['Amiri', 'Kanz-al-Marjaan', 'Arial Unicode MS', 'serif'],
        ui: ['Inter', 'Lato', 'Helvetica', 'Arial', 'sans-serif'],
      },
      borderRadius: { card: '12px', btn: '8px' },
      boxShadow: {
        // [PROPOSED] replace with exact values from Awraaq theme.css
        'glow-gold': '0 4px 14px rgba(201,168,76,0.35)',
        'glow-teal': '0 4px 14px rgba(15,91,90,0.30)',
      },
      minHeight: { tap: '44px' },
      minWidth: { tap: '44px' },
    },
  },
  plugins: [],
};
