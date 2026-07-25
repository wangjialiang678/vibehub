import { useEffect, useState } from 'react';

function pageIsVisible() {
  return typeof document === 'undefined' || !document.hidden;
}

export function usePageVisibility() {
  const [visible, setVisible] = useState(pageIsVisible);

  useEffect(() => {
    const update = () => setVisible(pageIsVisible());
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  return visible;
}
