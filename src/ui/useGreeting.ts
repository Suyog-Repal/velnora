import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { greetingForIndia, msUntilGreetingChange, type Greeting } from '../services/greeting';

/**
 * Current Indian-time greeting. Uses one timeout aimed at the next greeting boundary (no polling) and re-checks when
 * the app returns to the foreground, since timers do not fire reliably while it is backgrounded.
 */
export function useGreeting(): Greeting {
  const [greeting, setGreeting] = useState<Greeting>(() => greetingForIndia());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      setGreeting(greetingForIndia());                    // same value → React skips the re-render
      timer = setTimeout(refresh, msUntilGreetingChange() + 250);
    };
    refresh();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => { if (timer) clearTimeout(timer); sub.remove(); };
  }, []);
  return greeting;
}
