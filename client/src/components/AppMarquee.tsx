import Marquee from "react-fast-marquee";
import type { ReactNode } from "react";
import styles from "./AppMarquee.module.css";

type Props = {
  children: ReactNode;
  speed?: number;
  className?: string;
  play?: boolean;
};

export function AppMarquee({ children, speed = 45, className, play = true }: Props) {
  return (
    <Marquee
      className={className ? `${styles.root} ${className}` : styles.root}
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
