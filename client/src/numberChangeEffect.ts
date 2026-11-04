/**
 * How a number that changes while the page is open shows it (`AnimatedNumberFlow`'s
 * `flashOnChange`): the strip's detail cards' balance and breakdown figures flash their cell
 * green or red, and the digits switch at once. The summary cards (the page's own total, an
 * account's hero) and the P/L figures keep the rolling digits, as does a currency switch, or
 * cached figures giving way to live ones.
 *
 * Trial since 2026-11-02 — false brings back the rolling digits on every change.
 */
export const NUMBER_CHANGE_FLASH_ENABLED = true;
