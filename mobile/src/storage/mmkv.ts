import { createMMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

// REBRAND (WorkPulse -> AINO): this MMKV id is the on-device STORAGE ADDRESS
// for every persisted value (auth token, prefs, cached queries). Renaming it
// does not migrate the store — it opens a brand-new empty one, logging every
// user out and wiping their local state. Keep frozen unless you ship an
// explicit copy-forward migration.
export const storage = createMMKV({ id: 'workpulse-app' });

export const mmkvStorage: StateStorage = {
  getItem: (name) => {
    const value = storage.getString(name);
    return value ?? null;
  },
  setItem: (name, value) => {
    storage.set(name, value);
  },
  removeItem: (name) => {
    storage.remove(name);
  },
};