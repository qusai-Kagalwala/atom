import { createContext } from 'react';

// Value: { theme, mode, resolvedMode, sync, motion, setTheme, setMode, setMotion, update }
//   motion       'system' | 'full' | 'reduced'   (animations; this device only)
//   theme        'teal' | 'navy' | 'maroon'
//   mode         'light' | 'dark' | 'system'   (what the person chose)
//   resolvedMode 'light' | 'dark'              (what is actually showing)
//   sync         'idle' | 'saved' | 'device-only'   (last attempt to save to their account)
const ThemeContext = createContext(null);

export default ThemeContext;
