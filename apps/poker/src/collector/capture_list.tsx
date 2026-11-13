import { memo, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

interface ListCardOptions {
  imageSrc?: string | undefined;
  alt?: string | undefined;
  label: string;
  id: string;
  secondaryText?: string | undefined;
  onOpen: () => void;
  openLabel: string;
}

declare global {
  interface Window {
    PokerLabList: { createCard: (options: ListCardOptions) => HTMLElement };
  }
}

/** OCR collection, review, database and gameplay share this grid and renderer. */
export function CaptureList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="capture-list grid" aria-label={label}>
      {children}
    </div>
  );
}

/** Adapt OCR's native card constructor without giving React its DOM ownership. */
export const CaptureListCard = memo(function CaptureListCard({
  className,
  ...options
}: ListCardOptions & { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const open = useRef(options.onOpen);
  open.current = options.onOpen;
  const { imageSrc, alt, label, id, secondaryText, openLabel } = options;
  useLayoutEffect(() => {
    const card = window.PokerLabList.createCard({
      imageSrc,
      alt,
      label,
      id,
      secondaryText,
      openLabel,
      onOpen: () => {
        open.current();
      },
    });
    if (className) card.classList.add(className);
    host.current?.replaceChildren(card);
    return () => {
      card.remove();
    };
  }, [imageSrc, alt, label, id, secondaryText, openLabel, className]);
  return <div ref={host} className="capture-list-slot" />;
});
