// Imported first thing in main.tsx, so the IME guard listens before any other keydown handler (lib/ime-guard.ts).
import { installImeGuard } from './ime-guard.js';

installImeGuard();
