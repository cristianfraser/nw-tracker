const clpFmt = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function formatClp(n: number) {
  return clpFmt.format(Math.round(n));
}

export function clpToUsd(clp: number, clpPerUsd: number) {
  if (!clpPerUsd) return 0;
  return clp / clpPerUsd;
}

export function formatUsd(n: number) {
  return usdFmt.format(Math.round(n));
}
