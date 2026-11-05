import { Monitor, Moon, Sun } from 'lucide-react';

// The brightness choices, in the order the pickers show them. Ids match MODE_IDS in themes.js.
export const MODES = [
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
  { id: 'system', label: 'Auto', Icon: Monitor },
];
