import Marquee from "react-fast-marquee";
import type { ReactNode } from "react";
import { cn } from "../../cn";
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
      className={cn(styles.root, className)}
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
