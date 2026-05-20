/**
 * Single entry point for v2 status state.
 *
 * Always import from here:
 *   import { useStatus } from '@/status/useStatus';
 *
 * Do NOT import StatusContext directly — that's an implementation detail.
 */

import { useContext } from 'react';
import { StatusContext } from './StatusContext';

export function useStatus() {
    return useContext(StatusContext);
}