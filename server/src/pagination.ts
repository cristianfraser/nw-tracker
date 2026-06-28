export type Paginated<T> = {
  rows: T[];
  total: number;
  page: number;
  page_size: number;
};

export function paginate<T>(
  all: readonly T[],
  page: number,
  pageSize: number
): Paginated<T> {
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const rows = all.slice(start, start + pageSize) as T[];
  return { rows, total, page: safePage, page_size: pageSize };
}

export function parsePageParams(
  query: Record<string, unknown>,
  defaultPageSize: number
): { page: number; pageSize: number } {
  const page = Math.max(1, Math.trunc(Number(query.page) || 1));
  const pageSize = Math.min(
    500,
    Math.max(1, Math.trunc(Number(query.page_size) || defaultPageSize))
  );
  return { page, pageSize };
}
