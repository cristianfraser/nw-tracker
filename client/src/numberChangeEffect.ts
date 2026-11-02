/**
 * How a number that changes while the page is open shows it (`AnimatedNumberFlow`'s
 * `changeEffect`): the strip cards' balance and breakdown flash their cell green or red, their
 * P/L figures dip in opacity, and the digits switch at once. A currency switch, or cached figures
 * giving way to live ones, keep the rolling digits.
 *
 * Trial since 2026-11-02 — false brings back the rolling digits on every change.
 */
export const NUMBER_CHANGE_FLASH_ENABLED = true;
