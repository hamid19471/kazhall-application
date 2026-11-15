import type { JSX, SVGProps } from "react";

/**
 * Decorative line glyphs for the outdoor/adventure catalogue (کوهنوردی، شکار،
 * کمپینگ و آفرود، ماهیگیری). All are `aria-hidden`: meaning always lives in the
 * adjacent text, never in the picture.
 */
type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...rest }: IconProps & { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Ridge line — the brand mark. */
export function PeakIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2 19 9 6l4 7 2.5-3.5L22 19Z" />
      <path d="M7.2 10.5h3.6" />
    </Svg>
  );
}

export function TentIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 4 3 19h18Z" />
      <path d="M12 4v15" />
      <path d="m9 19 3-6 3 6" />
    </Svg>
  );
}

export function ReceiptIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 3h12v18l-2.5-1.6L13 21l-2.5-1.6L8 21l-2-1.5Z" />
      <path d="M9 8h6M9 12h6" />
    </Svg>
  );
}



export function PrinterIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7 9V3h10v6" />
      <path d="M5 9h14a2 2 0 0 1 2 2v5h-4v4H7v-4H3v-5a2 2 0 0 1 2-2Z" />
      <path d="M7 16h10" />
    </Svg>
  );
}

export function CompassIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5Z" />
    </Svg>
  );
}

/** Magnifier — the catalogue search box. */
export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </Svg>
  );
}

/** Dismiss — clears a search, closes the variant dialog. */
export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </Svg>
  );
}

/** A crate — the "no products matched" empty state. */
export function BoxIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5Z" />
      <path d="M3 8.5 12 13l9-4.5" />
      <path d="M12 13v7" />
    </Svg>
  );
}
