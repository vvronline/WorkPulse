import { createMMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

// This MMKV id is the on-device STORAGE ADDRESS for every persisted value
// (auth token, prefs, cached queries). Renaming it does not migrate the store
// -- it opens a brand-new empty one, logging every user out and wiping state.
//
// Renamed workpulse-app -> aino-app as part of the AINO migration. That was
// only safe because the Android package id changed in the SAME change
// (app.workpulse.mobile -> app.aino.mobile), which already gives the app a
// fresh per-package data directory -- so there was no surviving store to
// strand. Do NOT rename this again on its own without a copy-forward
// migration. See docs/AINO_EAS_MIGRATION_PLAN.md A.5.
export const storage = createMMKV({ id: 'aino-app' });

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
