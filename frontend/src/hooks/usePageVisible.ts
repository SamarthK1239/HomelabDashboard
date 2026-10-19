import { useEffect, useState } from 'react';

/**
 * Tracks `document.visibilityState`.
 *
 * Polling loops subscribe to this so a dashboard left open on a background tab
 * stops hitting the server until someone looks at it again.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    onChange();
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}
