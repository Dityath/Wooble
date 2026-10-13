import { useEffect, useRef } from "react";
import type { SlashCommandItem } from "./slash-commands";

export interface SlashMenuListProps {
  listboxId: string;
  items: SlashCommandItem[];
  activeIndex: number;
  /** The id of an option, which the editor names in `aria-activedescendant`. */
  optionId(item: SlashCommandItem): string;
  onActivate(index: number): void;
  onSelect(index: number): void;
}

/**
 * The slash menu's options (see `SlashCommand` in `slash-menu.tsx`). Focus stays in the editor, which points at the
 * active option with `aria-activedescendant`, so the options are not focusable and the editor handles the keyboard.
 */
export function SlashMenuList({ listboxId, items, activeIndex, optionId, onActivate, onSelect }: SlashMenuListProps) {
  const listbox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keep the active option visible when the arrow keys move past the edge of the scrolled menu.
    if (items.length) listbox.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [items, activeIndex]);

  return (
    <>
      <div ref={listbox} id={listboxId} role="listbox" aria-label="Insert block" className="slash-menu-list">
        {items.map((item, index) => {
          const id = optionId(item);
          const Icon = item.icon;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users choose options from the editor, which keeps focus (aria-activedescendant) and handles Enter and the arrow keys.
            <div
              key={item.id}
              id={id}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              aria-labelledby={`${id}-title`}
              aria-describedby={`${id}-description`}
              className="slash-menu-option"
              onMouseMove={() => onActivate(index)}
              onClick={() => onSelect(index)}
            >
              <span className="slash-menu-icon" aria-hidden="true">
                <Icon size={16} />
              </span>
              <span className="slash-menu-text">
                <span id={`${id}-title`} className="slash-menu-title">
                  {item.title}
                </span>
                <span id={`${id}-description`} className="slash-menu-description">
                  {item.description}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      {items.length === 0 && (
        <p className="slash-menu-empty" role="status">
          No matching blocks
        </p>
      )}
    </>
  );
}
