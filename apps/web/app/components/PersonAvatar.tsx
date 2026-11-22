// A person's colored initial, the same on Picks, guest picks and Finalize
// (docs/specs/components.md, "PersonAvatar"). The color is the person's
// roster position, 1-based; positions past the palette wrap.
import { cn } from "../lib/cn";

// Static class names, so Tailwind generates each fill.
const FILLS = ["bg-person-1", "bg-person-2", "bg-person-3", "bg-person-4", "bg-person-5", "bg-person-6"];

export type PersonAvatarProps = {
  initial: string;
  color: number;
  // sm beside a name or on an item; lg in the Picks people bar.
  size?: "sm" | "lg";
  // Given, the avatar is an image with this name. Absent, it is decorative:
  // the name beside it is the label.
  label?: string;
  // A surface-colored ring, for avatars that overlap in a stack.
  outlined?: boolean;
};

export function personFill(color: number): string {
  return FILLS[(((color - 1) % FILLS.length) + FILLS.length) % FILLS.length];
}

export function PersonAvatar({ initial, color, size = "sm", label, outlined = false }: PersonAvatarProps) {
  const classes = cn(
    "flex shrink-0 items-center justify-center rounded-full font-semibold text-person-ink",
    size === "lg" ? "size-12 text-lg" : "size-7 text-xs",
    outlined && "ring-2 ring-surface",
    personFill(color),
  );
  if (label === undefined) {
    return (
      <span aria-hidden="true" className={classes}>
        {initial}
      </span>
    );
  }
  return (
    <span role="img" aria-label={label} title={label} className={classes}>
      <span aria-hidden="true">{initial}</span>
    </span>
  );
}
