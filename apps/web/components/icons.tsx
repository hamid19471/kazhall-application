import type { JSX, SVGProps } from "react";

/**
 * Inline icons.
 *
 * No icon package is installed and adding one would change the lockfile, so
 * these are hand-drawn 24×24 strokes on `currentColor` — which is also what
 * makes them survive the palette retarget and forced-colors mode without a
 * single hardcoded value.
 *
 * They are ALWAYS decorative: `aria-hidden` is baked in and cannot be
 * overridden by a caller, so every control that uses one must carry its own
 * text label or `aria-label`. An icon-only button with no accessible name is
 * the single most common a11y bug in a storefront header, and this makes it
 * impossible to write by accident.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, "children" | "aria-hidden">;

function Icon({
  className,
  children,
  ...rest
}: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      {...rest}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "size-5"}
    >
      {children}
    </svg>
  );
}

/** The wordmark's peak. Used at larger sizes, so it gets its own geometry. */
export function LogoMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 40 32"
      fill="none"
      className={className ?? "size-8"}
    >
      <path
        d="M2 29 14 7l7 12 4-6 11 16H2Z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path d="M10.4 15.2h7.2" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <circle cx="30" cy="6" r="3" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </Icon>
);

export const BasketIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 8h15l-1.4 11a2 2 0 0 1-2 1.8H7.9a2 2 0 0 1-2-1.8L4.5 8Z" />
    <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
  </Icon>
);

export const UserIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.8 20c.9-3.6 3.8-5.6 7.2-5.6s6.3 2 7.2 5.6" />
  </Icon>
);

export const HomeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10.6 12 4l8 6.6V20a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1v-9.4Z" />
  </Icon>
);

export const GridIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Icon>
);

export const HeartIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Icon {...p}>
    <path
      d="M12 20.2 4.9 13.3a4.6 4.6 0 0 1 0-6.6 4.8 4.8 0 0 1 6.7 0l.4.4.4-.4a4.8 4.8 0 0 1 6.7 0 4.6 4.6 0 0 1 0 6.6L12 20.2Z"
      fill={filled ? "currentColor" : "none"}
    />
  </Icon>
);

/**
 * Chevrons named by INLINE DIRECTION, not by screen direction.
 *
 * The app is `dir="rtl"`, and SVG path data is not mirrored by the direction
 * property — so "toward the inline start" is a chevron that visually points
 * RIGHT. Naming these `Left`/`Right` is how a back button ends up pointing at
 * the next page.
 */
export const ChevronStartIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m10 5 7 7-7 7" />
  </Icon>
);

export const ChevronEndIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m14 5-7 7 7 7" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 7.4V12l3 1.8" />
  </Icon>
);

export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.6 21 20H3l9-15.4Z" />
    <path d="M12 10v4" />
    <path d="M12 17.2h.01" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.8 4.4 4.4L19 7.6" />
  </Icon>
);

export const TruckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7.5h11v9H3z" />
    <path d="M14 11h3.6l2.4 3v2.5H14z" />
    <circle cx="7" cy="18" r="1.8" />
    <circle cx="17" cy="18" r="1.8" />
  </Icon>
);

export const ShieldIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.4 19 6v6.2c0 4-2.9 7.3-7 8.4-4.1-1.1-7-4.4-7-8.4V6l7-2.6Z" />
    <path d="m9 12 2.2 2.2L15.4 10" />
  </Icon>
);

export const CompassIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="m15.2 8.8-1.9 4.5-4.5 1.9 1.9-4.5 4.5-1.9Z" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Icon>
);

export const MinusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 12h13" />
  </Icon>
);

export const TrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.8 6.8h14.4" />
    <path d="M9.4 6.8V5.2a1 1 0 0 1 1-1h3.2a1 1 0 0 1 1 1v1.6" />
    <path d="M6.6 6.8 7.5 19a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l.9-12.2" />
  </Icon>
);

export const PinIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 21s6.4-5.6 6.4-10.2A6.4 6.4 0 0 0 5.6 10.8C5.6 15.4 12 21 12 21Z" />
    <circle cx="12" cy="10.6" r="2.4" />
  </Icon>
);

export const ChartIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20h16" />
    <path d="M7 20v-6.5M12 20V6M17 20v-9.5" />
  </Icon>
);

export const ScaleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v16" />
    <path d="M5 8h14" />
    <path d="M8 8 5 15h6L8 8Z" />
    <path d="M16 8l-3 7h6l-3-7Z" />
  </Icon>
);

export const BoxIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 8.4 12 4l8 4.4v7.2L12 20l-8-4.4V8.4Z" />
    <path d="M4 8.4 12 12.8l8-4.4M12 12.8V20" />
  </Icon>
);

// ---------------------------------------------------------------------------
// Admin console
//
// Added for the management sidebar. Same rules as everything above: 24×24,
// `currentColor` strokes, `aria-hidden` baked in, no icon package.
// ---------------------------------------------------------------------------

export const DashboardIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 13a8 8 0 1 1 16 0" />
    <path d="M12 13l4.5-4" />
    <path d="M4 13h2M18 13h2M12 5v2" />
  </Icon>
);

export const TagIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 11V5a1 1 0 0 1 1-1h6l8.5 8.5a1.5 1.5 0 0 1 0 2.1l-4.9 4.9a1.5 1.5 0 0 1-2.1 0L4 11Z" />
    <circle cx="8.5" cy="8.5" r="1.2" />
  </Icon>
);

export const SlidersIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 6h14M5 12h14M5 18h14" />
    <circle cx="9" cy="6" r="2" />
    <circle cx="15" cy="12" r="2" />
    <circle cx="8" cy="18" r="2" />
  </Icon>
);

export const LayersIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m12 3 8 4.2-8 4.2-8-4.2L12 3Z" />
    <path d="m4 12.2 8 4.2 8-4.2" />
    <path d="m4 16.6 8 4.2 8-4.2" />
  </Icon>
);

export const ReceiptIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 3h12v18l-3-1.6-3 1.6-3-1.6L6 21V3Z" />
    <path d="M9.5 8h5M9.5 12h5" />
  </Icon>
);

export const UsersIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.6a3 3 0 0 1 0 4.8M17.5 19.5a5.5 5.5 0 0 0-2.2-4.4" />
  </Icon>
);

export const TillIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 10h18v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9Z" />
    <path d="M6 10V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5" />
    <path d="M9.5 14.5h5" />
  </Icon>
);

export const StoreIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 9.5 5.4 4.8A1 1 0 0 1 6.36 4h11.28a1 1 0 0 1 .96.8L20 9.5" />
    <path d="M4 9.5a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0" />
    <path d="M5.5 12v7.5a.5.5 0 0 0 .5.5h12a.5.5 0 0 0 .5-.5V12" />
  </Icon>
);

export const KeyIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="12" r="3.5" />
    <path d="M11.5 12H20M17 12v3M20 12v2.5" />
  </Icon>
);

export const ClipboardIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 4h6v2.5H9V4Z" />
    <path d="M9 5.2H6.5A1.5 1.5 0 0 0 5 6.7v12.8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6.7a1.5 1.5 0 0 0-1.5-1.5H15" />
    <path d="M8.5 11h7M8.5 15h4.5" />
  </Icon>
);

export const MenuIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const LogoutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 6V4.5A1.5 1.5 0 0 0 12.5 3h-6A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h6a1.5 1.5 0 0 0 1.5-1.5V18" />
    <path d="M10 12h10M17 9l3 3-3 3" />
  </Icon>
);

export const RefreshIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <path d="M20 4v4h-4" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const FilterIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5h16l-6.2 7.3v5.4L10.2 20v-7.7L4 5Z" />
  </Icon>
);

export const EyeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
    <circle cx="12" cy="12" r="2.6" />
  </Icon>
);

export const LockIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 10.5h12v9H6v-9Z" />
    <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" />
  </Icon>
);

/**
 * A pencil — the RENAME affordance.
 *
 * Added for the catalogue vocabulary screens, where the only edit a row offers
 * is a rename and a text-only button would repeat the row's own label. It is
 * still decorative (`aria-hidden` is baked into `Icon`), so every button using
 * it carries its own accessible name.
 */
export const PencilIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10v3Z" />
    <path d="m14.5 5.5 4 4" />
  </Icon>
);
