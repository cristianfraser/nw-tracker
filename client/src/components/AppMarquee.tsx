import Marquee from "react-fast-marquee";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Horizontal scroll speed (react-fast-marquee `speed` prop). */
  speed?: number;
  className?: string;
  /** When false, ticker stays still (use while market data is loading). */
  play?: boolean;
};

/**
 * Bloomberg-style horizontal ticker. See {@link https://www.react-fast-marquee.com/documentation react-fast-marquee}.
 */
export function AppMarquee({ children, speed = 45, className, play = true }: Props) {
  return (
    <Marquee
      className={className ? `app-marquee ${className}` : "app-marquee"}
      gradient={false}
      speed={speed}
      play={play}
      pauseOnHover
      autoFill
    >
      {children}
    </Marquee>
  );
}
