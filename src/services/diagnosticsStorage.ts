import AsyncStorage from '@react-native-async-storage/async-storage';
import { diagnostics } from './diagnostics';

/**
 * Keeps the diagnostics ring buffer across launches (a sign-out usually happened in an EARLIER run), in the same JS runtime the
 * background tasks use. Imported first by index.ts. The stored text holds only what diagnostics.ts allows: event names, times,
 * status codes and counts. Events recorded before this runs are kept and merged.
 */
const KEY = 'velnora.diagnostics.v1';
void diagnostics.attach({ read: () => AsyncStorage.getItem(KEY), write: (value) => AsyncStorage.setItem(KEY, value) });
